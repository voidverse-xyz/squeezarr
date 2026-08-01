// The two ways the queue loop drains pending work: `runPendingJobs` runs scan/probe jobs inline
// (sequential, in this process), and `dispatchTranscodes` hands transcode jobs to idle runners
// (parallel, non-blocking — results arrive later over the WebSocket). Collaborators are injected
// into both so they can be unit-tested without a live database/ffmpeg/runner pool.
import * as db from "../../database/index.js";
import * as logging from "../logging.js";
import * as processing from "../processing.js";
import { COLLECTION, JOB_STATUS, FILE_STATUS } from "shared/domain.js";

// Undo a transcode claim/prepare when no runner could take it after all (a runner disconnected in
// the gap between the capacity check and the assignment). Returns the job to pending and the file
// to queued so the next pass retries it.
export function settleUnassignedTranscodeJob(job, file, jobId) {
    if (job?.status !== JOB_STATUS.running) {
        return job;
    }
    if (!file) {
        return {
            ...job,
            status: JOB_STATUS.failed,
            error: "File removed before runner assignment",
            finishedAt: Date.now(),
            lifecyclePhase: "failed",
        };
    }
    // Stop may win while prepare is doing asynchronous work before it publishes activeJobId.
    // That claimed generation is still terminal even though it never became the file owner. An
    // unrelated active owner remains fenced below and is never cleared by resetTranscode.
    if (file.status === FILE_STATUS.stopped || file.cancelled) {
        return {
            ...job,
            status: JOB_STATUS.failed,
            error: "Stopped before runner assignment",
            finishedAt: Date.now(),
            lifecyclePhase: "failed",
        };
    }
    return file.activeJobId === jobId
        ? {
              ...job,
              status: JOB_STATUS.pending,
              startedAt: null,
              preparedOutputPath: null,
              finalOutputPath: null,
              taskGenerationId: null,
              outputMode: null,
              lifecyclePhase: null,
          }
        : job;
}

export function settleJobForMissingFile(job) {
    return settleUnassignedTranscodeJob(job, null, null);
}

function errorMessage(error) {
    return error?.message || String(error);
}

function cleanupAggregate(message, errors) {
    return new AggregateError(errors, `${message}: ${errors.map(errorMessage).join("; ")}`);
}

async function persistInlineFailure(job, claimed, error) {
    logging.error("queue", `job ${claimed.jobId} (${claimed.type}) failed: ${errorMessage(error)}`);
    try {
        await job.fail(claimed.jobId, errorMessage(error));
    } catch (failError) {
        logging.error("queue", `could not mark job ${claimed.jobId} as failed: ${errorMessage(failError)}`);
        throw cleanupAggregate(`failure persistence for job ${claimed.jobId} rejected`, [error, failError]);
    }
}

async function releaseShutdownClaim(job, jobId) {
    try {
        await job.releaseClaim?.(jobId);
    } catch (releaseError) {
        logging.error("queue", `could not release shutdown claim ${jobId}: ${errorMessage(releaseError)}`);
        throw cleanupAggregate(`shutdown claim release for ${jobId} rejected`, [releaseError]);
    }
}

export async function resetTranscode(
    jobId,
    fileId,
    {
        updateJob = (updateFn) => db.update(COLLECTION.jobs, jobId, updateFn),
        updateFileLifecycle = (updateFn) => processing.updateFileLifecycle(fileId, updateFn),
    } = {},
) {
    if (!fileId) {
        let disposition = "stale";
        await updateJob((job) => {
            if (job?.status !== JOB_STATUS.running) {
                return job;
            }
            disposition = "reset";
            return { ...job, status: JOB_STATUS.pending, startedAt: null, lifecyclePhase: null };
        });
        return disposition;
    }

    // Lock order is file lifecycle section → serialized job mutation. The job callback decides the
    // disposition from the authoritative serialized state and must never wait for this file lock.
    let disposition = "stale";
    await updateFileLifecycle(async (file) => {
        const stopped = Boolean(file && (file.status === FILE_STATUS.stopped || file.cancelled));
        let transitioned = false;
        await updateJob((job) => {
            if (job?.status !== JOB_STATUS.running) {
                return job;
            }
            const settled = settleUnassignedTranscodeJob(job, file, jobId);
            transitioned = settled.status !== job.status;
            if (transitioned) {
                disposition = !file ? "missing" : stopped ? "stopped" : "reset";
            }
            return settled;
        });

        // A terminal completion/failure that won the job FIFO remains authoritative. In
        // particular, preserve its file owner for finalization or startup recovery to release.
        if (!transitioned || file?.activeJobId !== jobId) {
            return file;
        }
        return {
            ...file,
            status: stopped ? FILE_STATUS.stopped : FILE_STATUS.queued,
            cancelled: stopped ? false : file.cancelled,
            activeJobId: null,
            activeSettingId: null,
            activePhase: null,
            failureMessage: null,
            currentOutputPath: null,
            reservedOutputPath: null,
            processingStartedAt: null,
            overwriteJournal: null,
            adjacentJournal: null,
        };
    });
    return disposition;
}

// Claim and run a batch of pending jobs, one at a time. Stops before starting a new job if the
// loop is shutting down ("stopped") or processing was paused mid-batch ("paused") — the job
// already running is awaited to completion either way, only new starts are withheld.
export async function runPendingJobs(pendingJobs, { handlers, job, getSettings, isRunning }) {
    for (const pendingJob of pendingJobs) {
        if (!isRunning()) {
            return "stopped";
        }

        // The pause flag read before the batch goes stale while a long batch runs, so re-check it
        // here: a pause landing mid-batch must withhold the next job (the running one finished
        // above). This is the regression guarded by tests/event.test.js.
        const settings = await getSettings();
        if (!isRunning()) {
            return "stopped";
        }
        if (settings.processingPaused) {
            return "paused";
        }

        const claimed = await job.claim(pendingJob.jobId);
        if (!claimed) {
            continue;
        }
        if (!isRunning()) {
            await releaseShutdownClaim(job, claimed.jobId);
            return "stopped";
        }

        const handler = handlers[claimed.type];
        if (!handler) {
            await persistInlineFailure(job, claimed, new Error(`No handler registered for type: ${claimed.type}`));
            if (!isRunning()) {
                return "stopped";
            }
            continue;
        }

        try {
            await handler(claimed);
            await job.complete(claimed.jobId);
        } catch (error) {
            await persistInlineFailure(job, claimed, error);
        }
        // A signal may land while completion/failure persistence is pending. Finish that terminal
        // write, then stop before this pass can report a clean drain or start another job.
        if (!isRunning()) {
            return "stopped";
        }
    }
    return "drained";
}

// Hand pending transcode jobs to idle runners — one per runner — without blocking the loop on the
// transcodes (their results arrive later over the WebSocket). Returns "saturated" when capacity
// runs out, "paused" when processing was paused mid-pass (mirrors runPendingJobs' pause semantics:
// a pause withholds the next assignment). Owner-blocked/deferred jobs also return "saturated" so
// processLoop sleeps until the active runner result wakes it instead of hot-spinning.
export async function dispatchTranscodes(
    pendingTranscodes,
    {
        idleRunnerCount,
        job,
        prepare,
        assign,
        reset,
        isPaused,
        getFile = (fileId) => processing.inspectFileLifecycle(fileId, (file) => file),
        validatePrepared = processing.validatePreparedTask,
        isRunning = () => true,
    },
) {
    let capacity = idleRunnerCount();
    let ownerBlocked = false;
    const selectedFileIds = new Set();
    for (const pendingJob of pendingTranscodes) {
        if (!isRunning()) {
            return "stopped";
        }
        if (capacity <= 0) {
            return "saturated";
        }
        const paused = await isPaused();
        if (!isRunning()) {
            return "stopped";
        }
        if (paused) {
            return "paused";
        }

        const pendingFileId = pendingJob.payload?.fileId;
        if (pendingFileId) {
            if (selectedFileIds.has(pendingFileId)) {
                ownerBlocked = true;
                continue;
            }
            const file = await getFile(pendingFileId);
            if (!isRunning()) {
                return "stopped";
            }
            if (file?.activeJobId) {
                ownerBlocked = true;
                continue;
            }
        }

        const claimed = await job.claim(pendingJob.jobId);
        if (!claimed) {
            continue;
        }
        const fileId = claimed.payload?.fileId;
        if (!isRunning()) {
            await releaseShutdownClaim(job, claimed.jobId);
            return "stopped";
        }
        if (fileId) {
            selectedFileIds.add(fileId);
        }

        // Tracks whether the rejection came from reset itself rather than prepare/validation/
        // assignment. A reset rejection remains fatal even if the retry below succeeds: the queue
        // cannot claim a clean drain after any durable cleanup operation rejected.
        let cleanupOperation = null;
        try {
            const prepared = await prepare(claimed);
            if (!isRunning()) {
                cleanupOperation = "reset";
                await reset(claimed.jobId, prepared?.fileId || fileId);
                cleanupOperation = null;
                return "stopped";
            }
            if (prepared?.deferred) {
                cleanupOperation = "reset";
                await reset(claimed.jobId, prepared.fileId || fileId);
                cleanupOperation = null;
                ownerBlocked = true;
                continue;
            }
            if (!prepared) {
                // Nothing to run (file already terminal, or the setting is missing/disabled).
                await job.complete(claimed.jobId);
                if (!isRunning()) {
                    return "stopped";
                }
                continue;
            }

            const valid = await validatePrepared(claimed.jobId, prepared);
            if (!isRunning()) {
                cleanupOperation = "reset";
                await reset(claimed.jobId, prepared.fileId);
                cleanupOperation = null;
                return "stopped";
            }
            if (!valid) {
                cleanupOperation = "reset";
                const disposition = await reset(claimed.jobId, prepared.fileId);
                cleanupOperation = null;
                if (disposition === "reset") {
                    ownerBlocked = true;
                }
                if (!isRunning()) {
                    return "stopped";
                }
                continue;
            }

            if (!isRunning()) {
                cleanupOperation = "reset";
                await reset(claimed.jobId, prepared.fileId);
                cleanupOperation = null;
                return "stopped";
            }
            const handed = await assign(claimed.jobId, prepared);
            if (!handed) {
                // The idle runner vanished between the capacity check and here — put it back.
                cleanupOperation = "reset";
                await reset(claimed.jobId, prepared.fileId);
                cleanupOperation = null;
                return "saturated";
            }
            capacity -= 1;
        } catch (error) {
            const errors = [error];
            let cleanupRejected = cleanupOperation !== null;
            if (cleanupRejected) {
                logging.error(
                    "queue",
                    `could not ${cleanupOperation} transcode ${claimed.jobId}: ${errorMessage(error)}`,
                );
            } else {
                logging.error("queue", `transcode dispatch ${claimed.jobId} failed: ${errorMessage(error)}`);
            }

            // Attempt every settlement step even after one rejects. Successful later steps reduce
            // durable damage, while every rejected cleanup is retained in the AggregateError.
            if (fileId) {
                try {
                    await reset(claimed.jobId, fileId);
                } catch (resetError) {
                    cleanupRejected = true;
                    errors.push(resetError);
                    logging.error("queue", `could not reset file ${fileId}: ${errorMessage(resetError)}`);
                }
            }
            try {
                await job.fail(claimed.jobId, errorMessage(error));
            } catch (failError) {
                cleanupRejected = true;
                errors.push(failError);
                logging.error("queue", `could not mark job ${claimed.jobId} as failed: ${errorMessage(failError)}`);
            }
            if (pendingFileId && fileId) {
                try {
                    await processing.recomputeFileStatus(fileId);
                } catch (statusError) {
                    cleanupRejected = true;
                    errors.push(statusError);
                    logging.error("queue", `could not recompute file ${fileId}: ${errorMessage(statusError)}`);
                }
            }
            if (cleanupRejected) {
                throw cleanupAggregate(`transcode cleanup for ${claimed.jobId} rejected`, errors);
            }
            if (!isRunning()) {
                return "stopped";
            }
        }
    }
    return ownerBlocked ? "saturated" : "drained";
}
