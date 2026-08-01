// Reclaim work from a runner that vanished. The in-memory assignment lease is claimed before this
// function is called; durable recovery proceeds only while the same job and file owner remain active.
import { unlink } from "fs/promises";
import * as db from "../../database/index.js";
import * as processing from "../processing.js";
import * as logging from "../logging.js";
import { COLLECTION, FILE_STATUS, JOB_STATUS } from "shared/domain.js";

export function fileBelongsToJob(file, jobId) {
    return Boolean(
        file && file.activeJobId === jobId && [FILE_STATUS.processing, FILE_STATUS.stopped].includes(file.status),
    );
}

// The job owns the prepared path durably; the file copy must agree before cleanup is authorized.
export function outputPathForLostJob(file, transcodeJob) {
    if (!fileBelongsToJob(file, transcodeJob?.jobId)) {
        return null;
    }
    return file.currentOutputPath === transcodeJob.preparedOutputPath ? transcodeJob.preparedOutputPath : null;
}

// Retired scratch generations remain scanner exclusions even after best-effort unlink: an executor
// behind a partition can recreate them later. Overwrite backup is monitor-created, but retaining its
// task-owned name closes the same delayed-filesystem-artifact hole.
export function retiredPathsForLostJob(file, transcodeJob) {
    if (!fileBelongsToJob(file, transcodeJob?.jobId)) {
        return file?.retiredOutputPaths || [];
    }
    const adjacent = file.adjacentJournal?.jobId === transcodeJob.jobId ? file.adjacentJournal : null;
    const overwrite = file.overwriteJournal?.jobId === transcodeJob.jobId ? file.overwriteJournal : null;
    return [
        ...(file.retiredOutputPaths || []),
        transcodeJob.preparedOutputPath,
        file.currentOutputPath,
        adjacent?.scratchPath,
        overwrite?.tempPath,
        overwrite?.backupPath,
    ].filter((path, index, paths) => path && paths.indexOf(path) === index);
}

export function createLostWorkRecovery({
    database = db,
    processingService = processing,
    unlinkFile = unlink,
    logger = logging,
    now = Date.now,
} = {}) {
    async function transitionRunningJob(jobId, fields) {
        // The facade serializes this predicate with completion/failure for the same job. Callers
        // reach it only after any required file transition, preserving file → job lock order.
        return database.update(COLLECTION.jobs, jobId, (currentJob) =>
            currentJob?.status === JOB_STATUS.running ? { ...currentJob, ...fields } : null,
        );
    }

    async function retireOwner(file, transcodeJob, { requireActive, status, patch = {} } = {}) {
        const retiredOutputPaths = retiredPathsForLostJob(file, transcodeJob);
        return processingService.transitionOwner(
            file.fileId,
            transcodeJob.jobId,
            {
                ...patch,
                ...(status ? { status } : {}),
                cancelled: false,
                activeJobId: null,
                activeSettingId: null,
                activePhase: null,
                currentOutputPath: null,
                reservedOutputPath: null,
                processingStartedAt: null,
                overwriteJournal: null,
                adjacentJournal: null,
                retiredOutputPaths,
            },
            { requireActive },
        );
    }

    // Returns true only when this invocation made an authoritative running-job transition.
    return async function requeueLostWork(jobId, fileId) {
        const transcodeJob = await database.get(COLLECTION.jobs, jobId);
        if (!transcodeJob || transcodeJob.status !== JOB_STATUS.running) {
            return false;
        }

        const file = fileId ? await database.get(COLLECTION.files, fileId) : null;
        if (!fileBelongsToJob(file, jobId)) {
            const failed = await transitionRunningJob(jobId, {
                status: JOB_STATUS.failed,
                error: "Runner lost after durable file ownership changed",
                finishedAt: now(),
                lifecyclePhase: "failed",
            });
            return Boolean(failed);
        }

        const outputPath = outputPathForLostJob(file, transcodeJob);
        let cleanupError = null;
        if (outputPath) {
            try {
                await unlinkFile(outputPath);
            } catch (error) {
                if (error.code !== "ENOENT") {
                    cleanupError = error;
                }
            }
        }

        if (cleanupError) {
            const patch = { errorMessage: `Output cleanup after runner loss failed: ${cleanupError.message}` };
            const retiredAsFailed = await retireOwner(file, transcodeJob, {
                requireActive: true,
                status: FILE_STATUS.failed,
                patch,
            });
            if (!retiredAsFailed) {
                const current = await processingService.getOwnedFile(fileId, jobId);
                if (current && (current.status === FILE_STATUS.stopped || current.cancelled)) {
                    await retireOwner(current, transcodeJob, { requireActive: false, patch });
                }
            }
            await transitionRunningJob(jobId, {
                status: JOB_STATUS.failed,
                error: cleanupError.message,
                finishedAt: now(),
                lifecyclePhase: "failed",
            });
            return true;
        }

        // This is the stop/result race's commit point. It shares processing's per-file lifecycle
        // serialization with cancel(), and transitionOwner conditionally requires the matching
        // active file owner. An acknowledged stop makes requireActive fail, so stale recovery can
        // never write queued/cancelled=false over stopped.
        const releasedForRetry = await retireOwner(file, transcodeJob, {
            requireActive: true,
            status: FILE_STATUS.queued,
        });
        if (!releasedForRetry) {
            const current = await processingService.getOwnedFile(fileId, jobId);
            if (current && (current.status === FILE_STATUS.stopped || current.cancelled)) {
                // Stop won. Retire only the old generation while preserving stopped status.
                await retireOwner(current, transcodeJob, { requireActive: false });
                await transitionRunningJob(jobId, {
                    status: JOB_STATUS.failed,
                    error: "Runner disconnected while task was stopped",
                    finishedAt: now(),
                    lifecyclePhase: "failed",
                });
                return true;
            }
            await transitionRunningJob(jobId, {
                status: JOB_STATUS.failed,
                error: "Runner lost after prepared output ownership changed",
                finishedAt: now(),
                lifecyclePhase: "failed",
            });
            return false;
        }

        // Reuse the durable job owner but clear every preparation field. prepareTranscode supplies
        // a fresh taskGenerationId and scratch path, while retiredOutputPaths fences the old one.
        const requeued = await transitionRunningJob(jobId, {
            status: JOB_STATUS.pending,
            startedAt: null,
            finishedAt: null,
            progress: null,
            error: null,
            preparedOutputPath: null,
            finalOutputPath: null,
            taskGenerationId: null,
            outputMode: null,
            lifecyclePhase: null,
        });
        if (!requeued) {
            return false;
        }
        logger.log("runnerpool", `requeued ${jobId} with a fresh task generation after runner loss`);
        return true;
    };
}

export const requeueLostWork = createLostWorkRecovery();
