// Process-wide graceful-shutdown coordination. The acceptance barrier is synchronous: once
// shutdown() returns to the event loop, no new HTTP request, queue claim, runner registration, or
// assignment may start. The cached promise then drains admitted work before persistence closes.
import * as logging from "./logging.js";
import * as readiness from "./readiness.js";
import { SHUTDOWN_DEADLINE_MS } from "../utilities/constants.js";

const REQUEST_LIFECYCLE = Symbol("requestLifecycle");

// Express does not expose a downstream async handler promise to ordinary middleware. API route
// handlers therefore use this wrapper to keep their admitted request tracked until the handler's
// returned promise settles, even when the client disconnects first.
export function trackRequestHandler(handler) {
    return function trackedRequestHandler(req, res, next) {
        const finishHandler = req[REQUEST_LIFECYCLE]?.beginHandler();
        let result;
        try {
            result = handler(req, res, next);
        } catch (error) {
            finishHandler?.();
            throw error;
        }
        if (!result || typeof result.then !== "function") {
            finishHandler?.();
            return result;
        }
        return Promise.resolve(result).finally(() => finishHandler?.());
    };
}

export function createRequestTracker() {
    let accepting = true;
    const active = new Set();
    const idleWaiters = new Set();

    const notifyIdle = () => {
        if (active.size !== 0) {
            return;
        }
        for (const resolve of idleWaiters) {
            resolve();
        }
        idleWaiters.clear();
    };

    return {
        middleware(req, res, next) {
            if (!accepting) {
                res.set("Connection", "close").status(503).send("Service unavailable");
                return;
            }

            const request = { req, res };
            active.add(request);
            let settled = false;
            let transportSettled = false;
            let trackedHandlers = 0;
            const settle = () => {
                if (settled) return;
                settled = true;
                active.delete(request);
                delete req[REQUEST_LIFECYCLE];
                notifyIdle();
            };
            const lifecycle = {
                beginHandler() {
                    trackedHandlers += 1;
                    let handlerSettled = false;
                    return () => {
                        if (handlerSettled) return;
                        handlerSettled = true;
                        trackedHandlers -= 1;
                        if (trackedHandlers === 0) settle();
                    };
                },
            };
            Object.defineProperty(req, REQUEST_LIFECYCLE, { value: lifecycle, configurable: true });
            const settleTransport = () => {
                transportSettled = true;
                // Static/fallback requests have no tracked persistence handler. Their transport is
                // the only asynchronous chain, while API handlers settle themselves above.
                queueMicrotask(() => {
                    if (transportSettled && trackedHandlers === 0) settle();
                });
            };
            res.once("finish", settleTransport);
            res.once("close", settleTransport);
            next();
        },
        stopAccepting() {
            accepting = false;
        },
        isAccepting() {
            return accepting;
        },
        activeCount() {
            return active.size;
        },
        waitForIdle() {
            if (active.size === 0) {
                return Promise.resolve();
            }
            return new Promise((resolve) => idleWaiters.add(resolve));
        },
    };
}

function closeHttpServer(server) {
    if (!server) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

export function createShutdownCoordinator({
    requestTracker = null,
    getHttpServer = () => null,
    getStartupPromise = () => null,
    isStarted = () => true,
    autoscanService = null,
    eventService = null,
    runnerpoolService = null,
    runnerService = null,
    database = null,
    mongoService = null,
    readinessService = readiness,
    logger = logging,
    deadlineMs = SHUTDOWN_DEADLINE_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    exit = (code) => process.exit(code),
} = {}) {
    let shuttingDown = false;
    let shutdownPromise = null;
    let deadlineExpired = false;
    let failureRequested = false;
    let exited = false;

    const exitOnce = (code) => {
        if (exited) {
            return;
        }
        exited = true;
        exit(code);
    };

    const record = async (errors, label, operation) => {
        if (!operation) {
            return;
        }
        try {
            await (typeof operation === "function" ? operation() : operation);
        } catch (error) {
            errors.push({ label, error });
            logger.error("shutdown", `${label} failed: ${error.message}`);
        }
    };

    const forceCloseTransports = () => {
        const server = getHttpServer();
        try {
            server?.closeAllConnections?.();
        } catch {}
        try {
            runnerpoolService?.forceShutdown?.();
        } catch {}
        try {
            runnerService?.forceShutdown?.();
        } catch {}
    };

    function shutdown(reason = "shutdown", { failed = false } = {}) {
        // Severity is monotonic even when a fatal callback joins a signal-initiated drain.
        if (failed) failureRequested = true;
        if (shutdownPromise) {
            return shutdownPromise;
        }
        shuttingDown = true;
        logger.log("shutdown", `${reason} — stopping acceptance`);

        const barrierErrors = [];
        const barrier = (label, operation) => {
            try {
                return operation?.();
            } catch (error) {
                barrierErrors.push({ label, error });
                logger.error("shutdown", `${label} failed: ${error.message}`);
                return null;
            }
        };

        // Acceptance barrier: do not insert an await above or within this block. A broken action is
        // aggregated but cannot prevent the remaining acceptance gates from closing.
        barrier("readiness stop", () => readinessService?.setSubsystem?.("http", false, "stopping"));
        barrier("HTTP acceptance stop", () => requestTracker?.stopAccepting());
        const autoscanDrain = barrier("autoscan stop", () => autoscanService?.shutdown?.());
        barrier("runner pool acceptance stop", () => runnerpoolService?.beginShutdown?.());
        const queueDrain = barrier("queue stop", () => eventService?.shutdown?.());
        const runnerDrain = barrier("local runner stop", () => runnerService?.shutdown?.());
        const poolDrain = barrier("runner pool stop", () => runnerpoolService?.shutdown?.());
        const httpDrain = isStarted("http")
            ? barrier("HTTP server stop", () => closeHttpServer(getHttpServer()))
            : null;

        shutdownPromise = new Promise((resolve) => {
            const timer = setTimer(() => {
                deadlineExpired = true;
                failureRequested = true;
                const queueState = eventService?.getState?.();
                const poolState = runnerpoolService?.getShutdownState?.();
                logger.error(
                    "shutdown",
                    `deadline expired (requests=${requestTracker?.activeCount?.() ?? 0}, queue=${queueState?.status ?? "n/a"}, sockets=${poolState?.socketCount ?? 0})`,
                );
                forceCloseTransports();
                exitOnce(1);
                resolve({ exitCode: 1, deadlineExpired: true, errors: [] });
            }, deadlineMs);
            timer.unref?.();

            void (async () => {
                const errors = [...barrierErrors];
                await record(errors, "startup drain", getStartupPromise);
                await Promise.all([
                    record(errors, "HTTP server drain", httpDrain),
                    record(errors, "HTTP request drain", () => requestTracker?.waitForIdle?.()),
                    record(errors, "autoscan drain", autoscanDrain),
                    record(errors, "queue drain", queueDrain),
                    record(errors, "local runner drain", runnerDrain),
                    record(errors, "runner pool drain", poolDrain),
                ]);

                // A forced deadline exits the process instead of closing persistence beneath any
                // handler whose settlement is still unknown.
                if (deadlineExpired) {
                    return;
                }
                if (isStarted("database")) {
                    await record(errors, "database close", () => database?.close?.());
                }
                if (isStarted("mongod")) {
                    await record(errors, "mongod stop", () => mongoService?.stop?.());
                }

                clearTimer(timer);
                const exitCode = failureRequested || errors.length > 0 ? 1 : 0;
                exitOnce(exitCode);
                resolve({ exitCode, deadlineExpired: false, errors });
            })();
        });
        return shutdownPromise;
    }

    return {
        shutdown,
        isShuttingDown: () => shuttingDown,
        getPromise: () => shutdownPromise,
    };
}
