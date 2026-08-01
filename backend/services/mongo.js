import { spawn } from "child_process";
import { once } from "events";
import { mkdir } from "fs/promises";
import net from "net";
import path from "path";
import * as logging from "./logging.js";
import * as readiness from "./readiness.js";
import { MONGO_HOST, MONGO_PORT } from "../utilities/constants.js";

// Host/port are fixed in utilities/constants.js (shared with the driver in database/connection.js).
// The on-disk dbpath is the only runtime knob — it follows CONFIG_DIR.
const DATA_DIR = path.join(process.env.CONFIG_DIR || "/config", "mongodb");

const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 500;
// How long to wait for a graceful SIGTERM exit before forcing SIGKILL on shutdown.
const STOP_TIMEOUT_MS = 5000;

let child = null;
let ready = false;
let status = "stopped";

function terminateMonitor() {
    process.exit(1);
}

export function getState() {
    return {
        ready: ready && child !== null && child.exitCode === null,
        status,
    };
}

// Start the local mongod. Resolves once mongod is accepting connections; rejects if the
// binary is missing or never becomes ready. Once startup has completed, any unexpected exit is
// fatal: the monitor cannot safely persist work, so the container restart policy must recover it.
export async function start({
    spawnProcess = spawn,
    waitUntilReady = waitForPort,
    ensureDataDir = mkdir,
    onFatal = terminateMonitor,
} = {}) {
    if (child) {
        return;
    }

    await ensureDataDir(DATA_DIR, { recursive: true });
    ready = false;
    status = "starting";
    readiness.setSubsystem("mongod", false, status);
    logging.log("mongod", `starting local MongoDB (dbpath: ${DATA_DIR}, port: ${MONGO_PORT})`);

    const proc = spawnProcess("mongod", ["--dbpath", DATA_DIR, "--bind_ip", MONGO_HOST, "--port", String(MONGO_PORT)], {
        stdio: ["ignore", "ignore", "inherit"],
    });
    child = proc;
    let starting = true;
    let intentionallyStopping = false;
    let fatalTriggered = false;
    let startupFailure;
    const failedDuringStartup = new Promise((_, reject) => {
        startupFailure = reject;
    });

    const failStartupOrMonitor = (error) => {
        ready = false;
        status = "failed";
        readiness.setSubsystem("mongod", false, status);
        if (starting) {
            startupFailure(error);
        } else if (!intentionallyStopping && !fatalTriggered) {
            fatalTriggered = true;
            logging.error("mongod", "local MongoDB stopped unexpectedly", error);
            onFatal(error);
        }
    };

    proc.once("error", (error) => {
        if (error.code === "ENOENT") {
            logging.error("mongod", "'mongod' not found — install MongoDB");
        } else {
            logging.error("mongod", `failed to start: ${error.message}`);
        }
        failStartupOrMonitor(error);
    });
    proc.once("exit", (code, signal) => {
        if (child === proc) {
            child = null;
        }
        ready = false;
        if (intentionallyStopping) {
            status = "stopped";
            readiness.setSubsystem("mongod", false, status);
            return;
        }
        const detail = signal ? `signal ${signal}` : `code ${code}`;
        failStartupOrMonitor(new Error(`mongod exited with ${detail}`));
    });

    try {
        await Promise.race([waitUntilReady(MONGO_PORT, READY_TIMEOUT_MS), failedDuringStartup]);
        starting = false;
        ready = true;
        status = "ready";
        readiness.setSubsystem("mongod", true);
        logging.log("mongod", "local MongoDB is ready");
    } catch (error) {
        starting = false;
        intentionallyStopping = true;
        ready = false;
        status = "failed";
        readiness.setSubsystem("mongod", false, status);
        if (child === proc) {
            child = null;
        }
        try {
            proc.kill("SIGTERM");
        } catch {
            // A spawn failure may leave no live process to terminate.
        }
        throw error;
    }

    // stop() marks this exact child as intentional through the closure rather than relying on its
    // exit code (mongod may legitimately use a nonzero code while being force-killed at shutdown).
    proc.markIntentionalStop = () => {
        intentionallyStopping = true;
    };
}

// Stop the local mongod and wait for it to actually exit, so the process doesn't race ahead
// and leave mongod writing. SIGTERM first; if it hasn't exited within STOP_TIMEOUT_MS, SIGKILL.
export async function stop() {
    ready = false;
    status = "stopping";
    readiness.setSubsystem("mongod", false, status);
    if (!child) {
        status = "stopped";
        readiness.setSubsystem("mongod", false, status);
        return;
    }
    const proc = child;
    proc.markIntentionalStop?.();
    child = null;
    const exited = once(proc, "exit");
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), STOP_TIMEOUT_MS);
    try {
        await exited;
    } catch {
        // already gone
    } finally {
        clearTimeout(timer);
        status = "stopped";
        readiness.setSubsystem("mongod", false, status);
    }
}

// Poll the port until mongod accepts a TCP connection, or give up after timeoutMs.
function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.connect(port, MONGO_HOST);
            socket.once("connect", () => {
                socket.destroy();
                resolve();
            });
            socket.once("error", () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    reject(new Error(`mongod did not become ready within ${timeoutMs}ms`));
                } else {
                    setTimeout(attempt, READY_POLL_MS);
                }
            });
        };
        attempt();
    });
}
