// Runner — the process that actually drives ffmpeg. It is a *pure executor*: it never touches
// MongoDB. It connects to the monitor over a WebSocket, waits for an `assign` message, spawns
// ffmpeg against the shared /data mount, streams progress + a heartbeat back, obeys `cancel`,
// and reports a `result` when ffmpeg exits. All persistence is the monitor's job.
//
// This file owns the connection lifecycle (connect/backoff/reconnect) and routes incoming
// messages; the work is split out: runner/task.js drives the one in-flight ffmpeg job, and
// runner/metrics.js samples and heartbeats the system metrics.
//
// Two callers (see backend/server.js):
//   - a remote runner process (HOST_IP set): host = HOST_IP, exitOnGiveUp = true — if it cannot
//     connect within RUNNER_CONNECT_MAX_MS it exits, so the container restarts/stops cleanly.
//   - the monitor's in-process local runner: host = 127.0.0.1, exitOnGiveUp = false — it must
//     never kill the monitor process, so it just keeps retrying.
import crypto from "crypto";
import WebSocket from "ws";
import * as task from "./runner/task.js";
import * as metrics from "./runner/metrics.js";
import * as logging from "./logging.js";
import * as auth from "./auth.js";
import { sendJson, readMessage } from "../utilities/wsjson.js";
import {
    RUNNER_WS_PATH,
    RUNNER_BACKOFF_BASE_MS,
    RUNNER_BACKOFF_MAX_MS,
    RUNNER_CONNECT_MAX_MS,
    RUNNER_CONNECT_ATTEMPT_TIMEOUT_MS,
    RUNNER_OUTAGE_WARNING_MS,
    RUNNER_SOCKET_CLOSE_TIMEOUT_MS,
} from "../utilities/constants.js";

// Re-exported so the pure helpers stay reachable at services/runner.js (the unit tests, and any
// caller, import them from here regardless of which submodule now owns them).
export { ffmpegErrorTail } from "./runner/task.js";
export { computeCpuPercent } from "./runner/metrics.js";

// The monitor's HTTP server (and the WS upgrade endpoint) defaults to the production app port;
// callers pass the real port to start() (the monitor passes its own PORT, so the in-process
// local runner follows it in dev too — see backend/server.js).
const DEFAULT_MONITOR_PORT = 3000;

const runnerId = crypto.randomUUID();

let host = null;
let port = DEFAULT_MONITOR_PORT;
let exitOnGiveUp = true;
let connectMaxMs = RUNNER_CONNECT_MAX_MS;
let fatalHandler = () => process.exit(1);
let fatalTriggered = false;
let stopped = false;

let ws = null;
let attempt = 0;
// First-failure timestamp of the current disconnected streak; the give-up window is measured
// from here and reset to null on every successful connect.
let giveUpSince = null;
let lastExtendedOutageWarningAt = null;
let reconnectTimer = null;
let clearConnectAttemptDeadline = null;
let shutdownPromise = null;

// Exponential backoff capped at RUNNER_BACKOFF_MAX_MS. Pure (no clock/IO) so it's unit-testable.
export function backoffDelay(attemptNumber) {
    return Math.min(RUNNER_BACKOFF_BASE_MS * 2 ** attemptNumber, RUNNER_BACKOFF_MAX_MS);
}

function triggerFatal(error) {
    if (fatalTriggered) return;
    fatalTriggered = true;
    fatalHandler(error);
}

// Remote runner processes report a fatal error at the give-up boundary so their process-level
// supervisor can drain and exit. The monitor-local runner remains monitor capacity and retries
// forever, publishing periodic warnings during an extended outage.
export function reconnectDecision(elapsedMs, shouldExitOnGiveUp, maxMs = RUNNER_CONNECT_MAX_MS) {
    if (elapsedMs < maxMs) {
        return { retry: true, exit: false, extendedOutage: false };
    }
    return shouldExitOnGiveUp
        ? { retry: false, exit: true, extendedOutage: true }
        : { retry: true, exit: false, extendedOutage: true };
}

export function armConnectAttemptDeadline(
    socket,
    {
        timeoutMs = RUNNER_CONNECT_ATTEMPT_TIMEOUT_MS,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        onTimeout = () => {},
    } = {},
) {
    let timer = setTimer(() => {
        timer = null;
        onTimeout();
        try {
            socket.terminate();
        } catch {}
    }, timeoutMs);
    timer?.unref?.();
    return () => {
        if (timer) {
            clearTimer(timer);
            timer = null;
        }
    };
}

function handleMessage(data, send) {
    if (stopped) {
        return;
    }
    const message = readMessage(data);
    if (!message) {
        return;
    }
    if (message.type === "assign") {
        task.startTask(message, send);
    } else if (message.type === "cancel") {
        task.cancelTask(message.taskId);
    }
}

function scheduleReconnect() {
    if (stopped) {
        return;
    }
    const now = Date.now();
    if (giveUpSince === null) {
        giveUpSince = now;
    }
    const decision = reconnectDecision(now - giveUpSince, exitOnGiveUp, connectMaxMs);
    if (decision.exit) {
        const error = new Error(`could not reach monitor at ${host} within ${connectMaxMs}ms`);
        logging.error("runner", `${error.message} — giving up`);
        triggerFatal(error);
        return;
    }
    if (
        decision.extendedOutage &&
        (lastExtendedOutageWarningAt === null || now - lastExtendedOutageWarningAt >= RUNNER_OUTAGE_WARNING_MS)
    ) {
        lastExtendedOutageWarningAt = now;
        logging.warn("runner", `monitor at ${host} remains unavailable — local runner will keep retrying`);
    }
    const delay = backoffDelay(attempt);
    attempt += 1;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function connect() {
    if (stopped) {
        return;
    }
    if (giveUpSince === null) {
        giveUpSince = Date.now();
    }
    const url = `ws://${host}:${port}${RUNNER_WS_PATH}`;
    const runnerToken = auth.getRunnerToken();
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${runnerToken}` } });
    ws = socket;
    clearConnectAttemptDeadline?.();
    const clearAttemptDeadline = armConnectAttemptDeadline(socket);
    clearConnectAttemptDeadline = clearAttemptDeadline;
    const clearAttempt = () => {
        clearAttemptDeadline();
        if (clearConnectAttemptDeadline === clearAttemptDeadline) clearConnectAttemptDeadline = null;
    };
    const send = (message) => sendJson(socket, message);
    let authFailed = false;

    socket.on("open", () => {
        clearAttempt();
        if (ws !== socket || stopped) {
            socket.close();
            return;
        }
        attempt = 0;
        giveUpSince = null;
        lastExtendedOutageWarningAt = null;
        logging.log("runner", `connected to monitor ${url} (runnerId ${runnerId})`);
        send({ type: "register", runnerId, host, info: metrics.collectStaticInfo() });
        metrics.startMetricsHeartbeat(send, runnerId);
    });
    socket.on("message", (data) => handleMessage(data, send));
    // 'error' is always followed by 'close'; schedule the reconnect from 'close' only so the
    // backoff never double-fires.
    socket.on("error", (error) => {
        if (error.message.includes("401")) {
            authFailed = true;
            logging.error("runner", "runner token mismatch - check SQUEEZARR_RUNNER_TOKEN on the monitor and runner");
            if (exitOnGiveUp) {
                triggerFatal(new Error("runner token mismatch"));
            }
            return;
        }
        logging.warn("runner", `socket error: ${error.message}`);
    });
    socket.on("close", () => {
        clearAttempt();
        // A callback from an obsolete socket must not stop metrics, abort work, or reconnect over
        // the connection that replaced it.
        if (ws !== socket) {
            return;
        }
        ws = null;
        metrics.stopMetricsHeartbeat();
        task.abortCurrent();
        if (!stopped && !authFailed) {
            scheduleReconnect();
        }
    });
}

export function start({
    host: targetHost,
    port: targetPort = DEFAULT_MONITOR_PORT,
    exitOnGiveUp: exit = true,
    onFatal = () => process.exit(1),
    maxConnectMs = RUNNER_CONNECT_MAX_MS,
}) {
    host = targetHost;
    port = targetPort;
    exitOnGiveUp = exit;
    fatalHandler = onFatal;
    fatalTriggered = false;
    connectMaxMs = maxConnectMs;
    stopped = false;
    shutdownPromise = null;
    attempt = 0;
    giveUpSince = null;
    lastExtendedOutageWarningAt = null;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    logging.log("runner", `starting runner (runnerId ${runnerId}), connecting to ${host}:${port}`);
    connect();
}

export function shutdown() {
    if (shutdownPromise) {
        return shutdownPromise;
    }
    // Synchronous barrier for this executor: no reconnect, heartbeat, task result, or new task can
    // begin once shutdown() returns its promise.
    stopped = true;
    clearConnectAttemptDeadline?.();
    clearConnectAttemptDeadline = null;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    metrics.stopMetricsHeartbeat();
    task.abortCurrent();
    const socket = ws;

    shutdownPromise = (async () => {
        if (!socket) {
            return;
        }
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
                }, RUNNER_SOCKET_CLOSE_TIMEOUT_MS);
                timer.unref?.();
                try {
                    socket.close(1001, "Runner shutting down");
                } catch {
                    try {
                        socket.terminate();
                    } catch {}
                    finish();
                }
            });
        }
        if (ws === socket) {
            ws = null;
        }
    })();
    return shutdownPromise;
}

export function forceShutdown() {
    stopped = true;
    metrics.stopMetricsHeartbeat();
    task.abortCurrent();
    try {
        ws?.terminate();
    } catch {}
}
