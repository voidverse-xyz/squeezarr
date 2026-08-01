// Messages received from runners. Every task-scoped message is validated against the exact socket,
// job, and assignment lease before it may touch durable state.
import * as job from "../job.js";
import * as ffmpegService from "../ffmpeg.js";
import * as logging from "../logging.js";
import * as registry from "./registry.js";
import { notifyIdle } from "./idle.js";
import { readMessage } from "../../utilities/wsjson.js";
import { requeueLostWork } from "./recovery.js";
import { JOB_STATUS } from "shared/domain.js";

export async function handleMessage(ws, data) {
    const message = readMessage(data);
    if (!message) {
        return;
    }

    switch (message.type) {
        case "register":
            await onRegister(ws, message);
            break;
        case "heartbeat":
            onHeartbeat(ws, message);
            break;
        case "progress":
            await onProgress(ws, message);
            break;
        case "result":
            await handleResult(ws, message);
            break;
        default:
            logging.warn("runnerpool", `unknown message type: ${message.type}`);
    }
}

async function onRegister(ws, message) {
    if (!registry.isAccepting()) {
        try {
            ws.close(1001, "Server shutting down");
        } catch {}
        return;
    }
    if (!message.runnerId) {
        logging.warn("runnerpool", "register without runnerId — ignoring");
        return;
    }

    // Reconnect and old close may race. Claiming recovery changes the stale assignment phase
    // synchronously, removal is expected-socket guarded, and a result already settling wins.
    const stale = registry.get(message.runnerId);
    if (stale?.ws === ws) {
        return;
    }
    if (stale) {
        const lost = registry.claimRecovery(stale);
        registry.remove(message.runnerId, stale.ws);
        try {
            stale.ws.terminate();
        } catch {}
        if (lost) {
            await requeueLostWork(lost.jobId, lost.fileId);
        }
    }

    const runner = registry.register(ws, message);
    if (!runner) {
        try {
            ws.close(1001, "Server shutting down");
        } catch {}
        return;
    }
    logging.log("runnerpool", `runner ${runner.runnerId} connected from ${runner.host}`);
    notifyIdle();
}

function onHeartbeat(ws, { runnerId, metrics }) {
    const runner = registry.get(runnerId);
    if (!runner || runner.ws !== ws) {
        return;
    }
    runner.lastHeartbeatAt = Date.now();
    if (metrics) {
        runner.metrics = metrics;
    }
}

async function onProgress(ws, { taskId, assignmentId, time }) {
    if (!registry.updateProgress(ws, taskId, assignmentId, time)) {
        return;
    }
    await job.updateProgress(taskId, time);
}

export async function handleResult(
    ws,
    { taskId, assignmentId, exitCode, cancelled, error },
    { jobs = job, ffmpeg = ffmpegService } = {},
) {
    // This claim is deliberately before the first await. Serialized close handling sees
    // "settling" and cannot recover this assignment; stale sockets/leases fail the claim.
    const runner = registry.claimResult(ws, taskId, assignmentId);
    if (!runner) {
        logging.warn("runnerpool", `ignored stale result for ${taskId ?? "unknown"}`);
        return;
    }

    const transcodeJob = await jobs.get(taskId);
    if (error && !cancelled) {
        logging.warn("runnerpool", `runner ${runner.runnerId} reported error for ${taskId}: ${error}`);
    }

    let settlementError = null;
    // Defense in depth beneath the lease: duplicate/recovered/terminal jobs never finalize.
    if (transcodeJob?.status === JOB_STATUS.running) {
        try {
            const outcome = await ffmpeg.finalizeTranscode(transcodeJob, { exitCode, cancelled, error });
            if (outcome?.ignored) {
                await jobs.failIfActive(taskId, "Runner result no longer owns the prepared transcode");
            } else if (outcome?.failed) {
                await jobs.failIfActive(taskId, outcome.error || error || "Transcode finalization failed");
            }
        } catch (finalizeError) {
            logging.error("runnerpool", `finalize ${taskId} failed: ${finalizeError.message}`);
            settlementError = finalizeError;
            try {
                await jobs.failIfActive(taskId, finalizeError.message);
            } catch (failureError) {
                settlementError = new AggregateError(
                    [finalizeError, failureError],
                    `finalize and failure persistence for ${taskId} failed`,
                );
            }
        }
    }

    if (registry.markIdle(runner, assignmentId)) {
        notifyIdle();
    }
    if (settlementError) throw settlementError;
}
