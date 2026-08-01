import { Worker } from "node:worker_threads";

const MATCH_TIMEOUT_MS = 100;
export const WORKER_STARTUP_TIMEOUT_MS = 1_000;
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.once("message", ({ pattern, value }) => {
    try {
        parentPort.postMessage({ type: "result", matched: new RegExp(pattern).test(value) });
    } catch {
        parentPort.postMessage({ type: "result", matched: false });
    }
});
parentPort.postMessage({ type: "ready" });
`;

const defaultWorkerFactory = (source, options) => new Worker(source, options);

// Keep worker creation and timers injectable so startup and execution deadlines can be tested
// independently without relying on scheduler timing.
export function createPatternMatcher({
    workerFactory = defaultWorkerFactory,
    startupTimeoutMs = WORKER_STARTUP_TIMEOUT_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
} = {}) {
    return function matchPattern(value, pattern, timeoutMs = MATCH_TIMEOUT_MS) {
        if (!pattern || pattern.trim() === "") {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            let worker;
            let startupTimer;
            let executionTimer;
            let online = false;
            let ready = false;
            let evaluating = false;
            let settled = false;

            const finish = (matched) => {
                if (settled) return;
                settled = true;
                if (startupTimer !== undefined) clearTimeoutImpl(startupTimer);
                if (executionTimer !== undefined) clearTimeoutImpl(executionTimer);
                if (worker) {
                    worker.off("online", handleOnline);
                    worker.off("message", handleMessage);
                    worker.off("error", handleFailure);
                    worker.off("exit", handleFailure);
                    try {
                        Promise.resolve(worker.terminate()).catch(() => {});
                    } catch {
                        // A failed worker may already be unavailable; matching still fails closed.
                    }
                }
                resolve(matched);
            };
            const beginEvaluation = () => {
                if (settled || evaluating || !online || !ready) return;
                evaluating = true;
                clearTimeoutImpl(startupTimer);
                startupTimer = undefined;
                executionTimer = setTimeoutImpl(() => finish(false), timeoutMs);
                try {
                    worker.postMessage({ pattern, value });
                } catch {
                    finish(false);
                }
            };
            const handleOnline = () => {
                online = true;
                beginEvaluation();
            };
            const handleMessage = (message) => {
                if (!evaluating && message?.type === "ready") {
                    ready = true;
                    beginEvaluation();
                    return;
                }
                if (evaluating && message?.type === "result") {
                    finish(message.matched === true);
                }
            };
            const handleFailure = () => finish(false);

            try {
                worker = workerFactory(WORKER_SOURCE, { eval: true });
                worker.once("online", handleOnline);
                worker.on("message", handleMessage);
                worker.once("error", handleFailure);
                worker.once("exit", handleFailure);
                startupTimer = setTimeoutImpl(() => finish(false), startupTimeoutMs);
            } catch {
                finish(false);
            }
        });
    };
}

// JavaScript regular expressions can backtrack catastrophically. Worker startup has its own
// bounded allowance; the execution budget begins only after the worker is online and ready.
export const matchesPattern = createPatternMatcher();
