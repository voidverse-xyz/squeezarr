// WebSocket transport for the pool. Message and close work is serialized per socket so a result
// that begins finalization cannot race disconnect recovery for the same assignment.
import { WebSocket, WebSocketServer } from "ws";
import * as logging from "../logging.js";
import * as auth from "../auth.js";
import * as registry from "./registry.js";
import * as readiness from "../readiness.js";
import { notifyIdle } from "./idle.js";
import { handleMessage } from "./inbound.js";
import { requeueLostWork } from "./recovery.js";
import {
    RUNNER_WS_PATH,
    RUNNER_HEARTBEAT_TIMEOUT_MS,
    RUNNER_WATCHDOG_MS,
    RUNNER_SOCKET_CLOSE_TIMEOUT_MS,
} from "../../utilities/constants.js";

let wss = null;
let watchdogTimer = null;
let attachedServer = null;
let upgradeHandler = null;
let shutdownPromise = null;
let shutdownSockets = [];
const trackedSockets = new Set();

// Queue work after all previously observed events for this socket. A rejection is logged and
// absorbed into the chain so one malformed frame cannot prevent the subsequent close cleanup.
export function serializeSocketEvent(ws, operation, onError = () => {}) {
    const previous = ws.runnerEventChain ?? Promise.resolve();
    const next = previous.then(operation);
    ws.runnerEventChain = next.catch((error) => {
        ws.runnerEventErrors ??= [];
        ws.runnerEventErrors.push(error);
        try {
            onError(error);
        } catch {}
    });
    return ws.runnerEventChain;
}

// Pure-clock watchdog pass (socket termination is injected by the fake socket in tests). Marking
// an expiry prevents repeated terminate calls while waiting for the close event.
export function evictStaleRunners(now = Date.now(), timeoutMs = RUNNER_HEARTBEAT_TIMEOUT_MS) {
    let evicted = 0;
    for (const runner of registry.all()) {
        if (runner.watchdogExpired || now - runner.lastHeartbeatAt <= timeoutMs) {
            continue;
        }
        runner.watchdogExpired = true;
        evicted += 1;
        logging.warn("runnerpool", `runner ${runner.runnerId} heartbeat expired`);
        try {
            runner.ws.terminate();
        } catch {}
    }
    if (evicted > 0) {
        registry.publishCapacity();
    }
    return evicted;
}

function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(() => evictStaleRunners(), RUNNER_WATCHDOG_MS);
    watchdogTimer.unref?.();
}

function stopWatchdog() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

export function attach(httpServer) {
    if (wss) {
        throw new Error("runner pool already attached");
    }
    shutdownPromise = null;
    shutdownSockets = [];
    trackedSockets.clear();
    registry.startAccepting();
    wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws) => handleConnection(ws));

    attachedServer = httpServer;
    upgradeHandler = (req, socket, head) => {
        if (!registry.isAccepting()) {
            socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        let pathname;
        try {
            pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
        } catch {
            socket.destroy();
            return;
        }
        if (pathname !== RUNNER_WS_PATH) {
            socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        if (!auth.verifyRunnerAuthorization(req.headers.authorization)) {
            logging.warn(
                "runnerpool",
                `runner token mismatch from ${req.socket.remoteAddress || "unknown"} - rejecting`,
            );
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            if (!registry.isAccepting() || !wss) {
                ws.close(1001, "Server shutting down");
                return;
            }
            wss.emit("connection", ws, req);
        });
    };
    httpServer.on("upgrade", upgradeHandler);
    registry.publishCapacity();
    startWatchdog();
}

function eventError(kind) {
    return (error) => logging.error("runnerpool", `${kind} handling failed: ${error.message}`);
}

function handleConnection(ws) {
    trackedSockets.add(ws);
    ws.on("message", (data) => serializeSocketEvent(ws, () => handleMessage(ws, data), eventError("message")));
    ws.on("close", () => {
        const chain = serializeSocketEvent(ws, () => handleClose(ws), eventError("close"));
        void chain.finally(() => {
            if (!ws.runnerEventErrors?.length) trackedSockets.delete(ws);
        });
    });
    ws.on("error", (error) => logging.warn("runnerpool", `runner socket error: ${error.message}`));
}

export async function handleClose(ws, { recover = requeueLostWork } = {}) {
    const runnerId = ws.runnerId;
    if (!runnerId) {
        return false;
    }
    const runner = registry.get(runnerId);
    if (!runner || runner.ws !== ws) {
        return false;
    }

    // Claim before removal. A result already settling wins and yields no recovery; otherwise this
    // close owns the only recovery attempt. Expected-socket removal protects a replacement socket.
    const lost = registry.claimRecovery(runner);
    registry.remove(runnerId, ws);
    logging.warn("runnerpool", `runner ${runnerId} disconnected`);
    if (lost) {
        await recover(lost.jobId, lost.fileId);
    }
    notifyIdle();
    return true;
}

function currentSockets() {
    return [...(wss?.clients || []), ...registry.all().map((runner) => runner.ws), ...trackedSockets].filter(
        (socket, index, sockets) => socket && sockets.indexOf(socket) === index,
    );
}

// Synchronous half of pool shutdown. It fences upgrade/register/assign first, captures every
// current socket, and initiates a normal going-away handshake before the coordinator awaits work.
export function beginShutdown() {
    if (!registry.isAccepting() && shutdownSockets.length > 0) {
        return;
    }
    registry.stopAccepting();
    stopWatchdog();
    shutdownSockets = currentSockets();
    for (const socket of shutdownSockets) {
        try {
            socket.close(1001, "Server shutting down");
        } catch {}
    }
}

export async function drainSocket(socket, timeoutMs = RUNNER_SOCKET_CLOSE_TIMEOUT_MS) {
    if (socket.readyState !== WebSocket.CLOSED) {
        await new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            socket.once("close", finish);
            timer = setTimeout(() => {
                try {
                    socket.terminate();
                } catch {
                    finish();
                }
            }, timeoutMs);
            timer.unref?.();
            try {
                socket.close(1001, "Server shutting down");
            } catch {
                finish();
            }
        });
    }
    // The close listener is registered before this waiter, so by this point close recovery has
    // been appended behind any result finalization. Read the chain only after that append.
    await Promise.resolve();
    await (socket.runnerEventChain ?? Promise.resolve());
    if (socket.runnerEventErrors?.length > 0) {
        throw new AggregateError(socket.runnerEventErrors, "runner socket event drain failed");
    }
}

function closeWebSocketServer(server) {
    if (!server) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        server.close((error) => (error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    });
}

export function shutdown() {
    if (shutdownPromise) {
        return shutdownPromise;
    }
    beginShutdown();
    const server = wss;
    const sockets = [...shutdownSockets];
    shutdownPromise = (async () => {
        const errors = [];
        const socketResults = await Promise.allSettled(sockets.map((socket) => drainSocket(socket)));
        for (const result of socketResults) {
            if (result.status === "rejected") errors.push(result.reason);
        }
        registry.clear();
        readiness.stopProcessing();
        trackedSockets.clear();
        if (attachedServer && upgradeHandler) {
            attachedServer.off("upgrade", upgradeHandler);
        }
        attachedServer = null;
        upgradeHandler = null;
        try {
            await closeWebSocketServer(server);
        } catch (error) {
            errors.push(error);
        }
        if (wss === server) {
            wss = null;
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "runner pool shutdown drain failed");
        }
    })();
    return shutdownPromise;
}

export function forceShutdown() {
    registry.stopAccepting();
    stopWatchdog();
    for (const socket of [...shutdownSockets, ...currentSockets()]) {
        try {
            socket.terminate();
        } catch {}
    }
}

export function getShutdownState() {
    return {
        accepting: registry.isAccepting(),
        socketCount: currentSockets().length,
        runnerCount: registry.all().length,
    };
}
