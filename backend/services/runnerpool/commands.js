// Commands sent *to* runners, plus the pause control that governs which runners may receive them:
// `assign` hands a prepared transcode to an idle runner, `relayCancellations` pushes a cancel to a
// busy runner whose file was stopped, and `setPaused` toggles a runner's availability.
import crypto from "crypto";
import * as db from "../../database/index.js";
import * as logging from "../logging.js";
import * as registry from "./registry.js";
import { notifyIdle } from "./idle.js";
import { sendJson } from "../../utilities/wsjson.js";
import { COLLECTION, RUNNER_STATUS } from "shared/domain.js";

// Pause/resume a single runner (UI-driven). A paused runner is skipped for new assignments but
// keeps running whatever it already has. Returns false if the runner isn't connected. Resuming
// nudges the dispatch loop so freed capacity is used right away.
export function setPaused(runnerId, paused) {
    if (!registry.setPaused(runnerId, paused)) {
        return false;
    }
    logging.log("runnerpool", `runner ${runnerId} ${paused ? "paused" : "resumed"}`);
    if (!paused) {
        notifyIdle();
    }
    return true;
}

// Hand a prepared transcode to an idle runner. Returns false if none is available (the caller
// should not have claimed the job in that case — the dispatcher guards with idleRunnerCount()).
// The runner is a pure executor: it only gets the command (`taskId`/`executable`/`args`/
// `inputPath`). The richer `currentFile` summary stays monitor-side on the record for the UI.
export async function assign(jobId, { fileId, executable, args, inputPath, currentFile }) {
    const runner = registry.firstIdle();
    // Final synchronous assignment gate. beginShutdown() flips this before any drain await, so a
    // prepared task can never cross the transport after the acceptance barrier.
    if (!runner || !registry.isAccepting()) {
        return false;
    }
    const assignmentId = crypto.randomUUID();
    registry.markBusy(runner, { jobId, assignmentId, fileId, currentFile });
    sendJson(runner.ws, { type: "assign", taskId: jobId, assignmentId, executable, args, inputPath });
    logging.log("runnerpool", `assigned ${jobId} to runner ${runner.runnerId}`);
    return true;
}

// Per pass of the event loop: for each busy runner whose file has been flagged cancelled (by the
// stop route, in a separate module instance), push a single cancel over the socket. The old
// in-ffmpeg DB poll can't reach a remote runner, so the monitor relays it.
export async function relayCancellations() {
    for (const runner of registry.all()) {
        if (runner.status !== RUNNER_STATUS.busy || runner.cancelSent || !runner.currentFileId) {
            continue;
        }
        const file = await db.get(COLLECTION.files, runner.currentFileId);
        if (file?.cancelled === true) {
            sendJson(runner.ws, { type: "cancel", taskId: runner.currentJobId });
            runner.cancelSent = true;
            logging.log("runnerpool", `relayed cancel for ${runner.currentJobId} to runner ${runner.runnerId}`);
        }
    }
}
