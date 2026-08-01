// The job queue loop — the heart of the pipeline. It owns the run/idle state, wakes on enqueue,
// and on each pass relays cancellations, splits pending jobs into transcodes (dispatched to
// runners) and inline jobs (scan/probe, run in-process), then sleeps until there's more to do.
// The draining logic lives in event/dispatch.js and the startup reconciliation in
// event/recovery.js; this file wires them to the live collaborators (runner pool, settings, jobs).
import * as job from "./job.js";
import * as settingsService from "./settings.js";
import * as ffmpegService from "./ffmpeg.js";
import * as runnerpool from "./runnerpool.js";
import * as logging from "./logging.js";
import * as readiness from "./readiness.js";
import { wakeup, waitForWork } from "./event/waiter.js";
import { recoverInterruptedJobs } from "./event/recovery.js";
import { runPendingJobs, dispatchTranscodes, resetTranscode } from "./event/dispatch.js";
import { JOB_TYPE } from "shared/domain.js";

// Re-exported so the unit tests (and any caller) can reach the draining logic at services/event.js,
// and so the stop route / enqueue can nudge the loop via eventService.wakeup.
export { wakeup } from "./event/waiter.js";
export { runPendingJobs, dispatchTranscodes } from "./event/dispatch.js";

const handlers = {};
let running = false;
let loopActive = false;
let lastError = null;
let loopError = null;
let loopPromise = Promise.resolve();
let drainPromise = null;

function terminateMonitor() {
    process.exit(1);
}

export function getState() {
    return {
        ready: running && loopActive && lastError === null,
        status: lastError ? "crashed" : loopActive ? "running" : "stopped",
    };
}

export function registerHandler(type, fn) {
    handlers[type] = fn;
}

export async function enqueue(type, payload = {}) {
    const created = await job.create(type, payload);
    wakeup();
    return created.jobId;
}

async function isPaused() {
    return (await settingsService.get()).processingPaused;
}

async function processLoop() {
    while (running) {
        // Turn any pending stop (DB `cancelled` flag) into a cancel message for the busy runner.
        // This runs *before* the pause gate: pausing withholds new work, but a job already running
        // on a worker must stay stoppable, so an active stop has to reach it even while the rest of
        // the pipeline rests.
        await runnerpool.relayCancellations();
        if (!running) {
            break;
        }

        // When processing is paused the whole pipeline rests — no scanning, probing, or
        // transcoding. We still wake on enqueue or after the idle timeout to re-check the flag.
        if (await isPaused()) {
            if (!running) {
                break;
            }
            await waitForWork();
            continue;
        }
        if (!running) {
            break;
        }

        const pendingJobs = await job.listPending();
        if (!running) {
            break;
        }
        const transcodes = [];
        const inline = [];
        for (const pendingJob of pendingJobs) {
            (pendingJob.type === JOB_TYPE.TRANSCODE_FILE ? transcodes : inline).push(pendingJob);
        }

        // Dispatch transcodes to idle runners (parallel, non-blocking).
        let dispatchStatus = "drained";
        if (transcodes.length > 0) {
            dispatchStatus = await dispatchTranscodes(transcodes, {
                idleRunnerCount: runnerpool.idleRunnerCount,
                job,
                prepare: ffmpegService.prepareTranscode,
                assign: runnerpool.assign,
                reset: resetTranscode,
                isPaused,
                isRunning: () => running,
            });
        }

        // Drain scan/probe inline (sequential, in this process).
        if (inline.length > 0) {
            await runPendingJobs(inline, {
                handlers,
                job,
                getSettings: () => settingsService.get(),
                isRunning: () => running,
            });
        }

        // Sleep when nothing more can be done right now: no inline work this pass and either no
        // transcodes or every runner is busy. wakeup() (enqueue, or a runner connecting/freeing)
        // breaks the wait so dispatch resumes immediately.
        if (inline.length === 0 && (transcodes.length === 0 || dispatchStatus === "saturated")) {
            await waitForWork();
        }
    }
}

export async function initialize({
    recover = recoverInterruptedJobs,
    loop = processLoop,
    onFatal = terminateMonitor,
} = {}) {
    if (running) {
        return;
    }
    running = true;
    loopActive = false;
    lastError = null;
    loopError = null;
    drainPromise = null;
    readiness.setSubsystem("queue", false, "recovering");

    // Let the runner pool nudge the loop the moment a runner connects or frees up.
    runnerpool.setIdleListener(wakeup);

    try {
        await recover();
    } catch (error) {
        running = false;
        lastError = error;
        readiness.setSubsystem("queue", false, "failed");
        throw error;
    }

    // shutdown() may have landed while startup recovery was awaiting the database. Do not revive
    // the loop after that synchronous stop barrier.
    if (!running) {
        readiness.setSubsystem("queue", false, "stopped");
        return;
    }

    loopActive = true;
    readiness.setSubsystem("queue", true);
    logging.log("queue", "started");

    // Keep the promise supervised. A top-level DB/settings/runner-pool rejection must clear the
    // lifecycle state (so it is observable and restartable) and then terminate the monitor. The
    // container's restart policy provides bounded, whole-process recovery for both queue and DB.
    loopPromise = Promise.resolve()
        .then(loop)
        .then(() => {
            if (running) {
                throw new Error("queue loop exited unexpectedly");
            }
        })
        .catch((error) => {
            loopError = error;
            lastError = error;
            if (!running) {
                readiness.setSubsystem("queue", false, "drain_failed");
                logging.error("queue", "shutdown drain failed", error);
                return;
            }
            running = false;
            loopActive = false;
            readiness.setSubsystem("queue", false, "crashed");
            logging.error("queue", "loop crashed", error);
            onFatal(error);
        })
        .finally(() => {
            loopActive = false;
            if (!lastError) {
                readiness.setSubsystem("queue", false, "stopped");
            }
        });
}

export function shutdown() {
    running = false;
    readiness.setSubsystem("queue", false, loopActive ? "draining" : "stopped");
    wakeup();
    if (!drainPromise) {
        drainPromise = loopPromise.then(() => {
            if (loopError) throw loopError;
        });
    }
    return drainPromise;
}
