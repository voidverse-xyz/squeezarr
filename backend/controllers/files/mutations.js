// Write side of the "files" resource: delete, replace, requeue, stop, and per-setting output
// removal. Every function returns the response envelope (getResult); failure is a returned value,
// never a thrown exception. There is no auth/role argument — this is a single-user, single-instance
// app (see AGENTS.md).
import { access, rename, unlink } from "fs/promises";
import * as db from "../../database/index.js";
import { eventService, processingService, loggingService, jobService } from "../../services/index.js";
import {
    COLLECTION,
    FILE_STATUS,
    JOB_TYPE,
    RESULT_STATUS,
    REQUEUEABLE_STATUSES,
    STOPPABLE_STATUSES,
} from "shared/domain.js";
import { getResult } from "shared/response.js";

const REQUEUE_ALLOWED = new Set(REQUEUEABLE_STATUSES);

export function hasUnsettledLifecycle(file) {
    return Boolean(file?.activeJobId || file?.activeProbeJobId || file?.adjacentJournal || file?.overwriteJournal);
}

export function stopFailureForFile(file) {
    if (file?.activePhase === "committing") {
        return "file_finalization_committed";
    }
    return STOPPABLE_STATUSES.includes(file?.status) ? null : "file_not_stoppable";
}

// ENOENT means deletion is already complete. Every other error leaves the ownership record
// untouched so scanner exclusion remains durable and cleanup can be retried.
export async function deleteTrackedOutput(outputPath, unlinkFile = unlink) {
    try {
        await unlinkFile(outputPath);
        return { deleted: true };
    } catch (error) {
        if (error.code === "ENOENT") {
            return { deleted: true };
        }
        return { deleted: false, error };
    }
}

export async function publishProbeJob(
    fileId,
    {
        reserveId = jobService.createId,
        publishOwner = async (probeJobId) => {
            let published = false;
            await processingService.updateFileLifecycle(fileId, (file) => {
                if (!file || file.status !== FILE_STATUS.pending || file.activeJobId || file.activeProbeJobId) {
                    return file;
                }
                published = true;
                return { ...file, activeProbeJobId: probeJobId };
            });
            return published;
        },
        createPending = (probeJobId) => jobService.createPending(JOB_TYPE.PROBE_FILE, { fileId }, probeJobId),
        clearOwner = (probeJobId) =>
            processingService.updateFileLifecycle(fileId, (file) =>
                file?.activeProbeJobId === probeJobId ? { ...file, activeProbeJobId: null } : file,
            ),
        wakeup = eventService.wakeup,
    } = {},
) {
    const probeJobId = reserveId();
    if (!(await publishOwner(probeJobId))) {
        throw new Error("File lifecycle changed before probe ownership could be published");
    }
    try {
        await createPending(probeJobId);
    } catch (error) {
        await clearOwner(probeJobId);
        throw error;
    }
    wakeup();
    return probeJobId;
}

async function deleteAllTrackedOutputs(file) {
    const paths = new Set([
        ...(file.transcodeResults || []).map((result) => result.outputPath),
        file.currentOutputPath,
        file.reservedOutputPath,
        ...(file.retiredOutputPaths || []),
        file.adjacentJournal?.scratchPath,
        file.adjacentJournal?.finalPath,
        file.overwriteJournal?.tempPath,
        file.overwriteJournal?.backupPath,
    ]);
    paths.delete(null);
    paths.delete(undefined);
    // The overwrite journal's sourcePath is intentionally never included: only owned outputs and
    // scratch/backup artifacts are cleanup candidates.
    paths.delete(file.path);
    for (const outputPath of paths) {
        const deletion = await deleteTrackedOutput(outputPath);
        if (!deletion.deleted) {
            return deletion;
        }
    }
    return { deleted: true };
}

export async function remove(fileId) {
    return processingService.withFileLifecycleCriticalSection(fileId, async () => {
        const file = await db.get(COLLECTION.files, fileId);
        if (!file) {
            return getResult(false, "file_not_found");
        }
        if (hasUnsettledLifecycle(file) || file.status === FILE_STATUS.processing) {
            return getResult(false, "file_lifecycle_unsettled");
        }

        const outputDeletion = await deleteAllTrackedOutputs(file);
        if (!outputDeletion.deleted) {
            await db.patch(COLLECTION.files, fileId, { errorMessage: outputDeletion.error.message });
            return getResult(false, `could_not_delete_output: ${outputDeletion.error.message}`);
        }

        try {
            await unlink(file.path);
        } catch (error) {
            if (error.code !== "ENOENT") {
                await db.patch(COLLECTION.files, fileId, { errorMessage: error.message });
                return getResult(false, `could_not_delete_file: ${error.message}`);
            }
            // ENOENT: file was already gone — proceed with DB removal.
        }

        await db.remove(COLLECTION.files, fileId);
        loggingService.log("api", `deleted ${file.path}`);
        return getResult(true, "file_deleted");
    });
}

export async function deleteOutput(fileId, settingId) {
    if (!settingId) {
        return getResult(false, "setting_id_required");
    }

    return processingService.withFileLifecycleCriticalSection(fileId, async () => {
        const file = await db.get(COLLECTION.files, fileId);
        if (!file) {
            return getResult(false, "file_not_found");
        }

        if (hasUnsettledLifecycle(file)) {
            return getResult(false, "file_lifecycle_unsettled");
        }

        const result = file.transcodeResults?.find((r) => r.settingId === settingId && r.outputPath);
        if (!result) {
            return getResult(false, "output_not_found");
        }

        const deletion = await deleteTrackedOutput(result.outputPath);
        if (!deletion.deleted) {
            await db.patch(COLLECTION.files, fileId, { errorMessage: deletion.error.message });
            return getResult(false, `could_not_delete_output: ${deletion.error.message}`);
        }
        await db.update(COLLECTION.files, fileId, (f) => ({
            ...f,
            transcodeResults: (f.transcodeResults || []).map((r) =>
                r.settingId === settingId ? { ...r, outputPath: null, outputSize: 0 } : r,
            ),
        }));

        return getResult(true, "output_deleted");
    });
}

export async function replace(fileId, settingId) {
    return processingService.withFileLifecycleCriticalSection(fileId, async () => {
        const file = await db.get(COLLECTION.files, fileId);
        if (!file) {
            return getResult(false, "file_not_found");
        }
        if (hasUnsettledLifecycle(file) || file.status === FILE_STATUS.processing) {
            return getResult(false, "file_lifecycle_unsettled");
        }

        const result = file.transcodeResults?.find(
            (r) => r.settingId === settingId && r.status === RESULT_STATUS.done && r.outputPath,
        );
        if (!result) {
            return getResult(false, "transcode_result_not_found");
        }

        try {
            await access(result.outputPath);
        } catch {
            return getResult(false, "output_missing_on_disk");
        }

        try {
            // rename() atomically replaces the destination on the same filesystem, so the original
            // is never deleted unless the output is already in place.
            await rename(result.outputPath, file.path);
        } catch (error) {
            return getResult(false, `replace_failed: ${error.message}`);
        }

        await db.update(COLLECTION.files, fileId, (f) => ({
            ...f,
            status: FILE_STATUS.replaced,
            replaced: true,
            replacedAt: new Date().toISOString(),
            size: result.outputSize,
            transcodeResults: (f.transcodeResults || []).map((r) =>
                r.settingId === settingId ? { ...r, outputPath: null, status: RESULT_STATUS.replaced } : r,
            ),
        }));
        loggingService.log("api", `replaced ${file.path} with "${result.settingName}" output`);
        return getResult(true, "file_replaced");
    });
}

export async function requeue(fileId) {
    return processingService.withFileLifecycleCriticalSection(fileId, async () => {
        const file = await db.get(COLLECTION.files, fileId);
        if (!file) {
            return getResult(false, "file_not_found");
        }
        if (!REQUEUE_ALLOWED.has(file.status)) {
            return getResult(false, "file_not_requeueable");
        }

        if (hasUnsettledLifecycle(file)) {
            return getResult(false, "file_stop_in_progress");
        }

        const outputDeletion = await deleteAllTrackedOutputs(file);
        if (!outputDeletion.deleted) {
            await db.patch(COLLECTION.files, fileId, { errorMessage: outputDeletion.error.message });
            return getResult(false, `could_not_delete_output: ${outputDeletion.error.message}`);
        }

        // Snapshot and conditionally fail the old generation while this file section is still held.
        // No job search occurs after publishing/releasing the new probe generation.
        await jobService.failOutstandingForFile(fileId, "Superseded by file requeue");
        await db.update(COLLECTION.files, fileId, (current) =>
            current
                ? {
                      ...current,
                      status: FILE_STATUS.pending,
                      errorMessage: null,
                      processedAt: null,
                      replaced: false,
                      cancelled: false,
                      activeJobId: null,
                      activeSettingId: null,
                      activeProbeJobId: null,
                      activePhase: null,
                      failureMessage: null,
                      currentOutputPath: null,
                      reservedOutputPath: null,
                      processingStartedAt: null,
                      overwriteJournal: null,
                      adjacentJournal: null,
                      transcodeResults: [],
                  }
                : current,
        );
        const probeJobId = jobService.createId();
        await db.update(COLLECTION.files, fileId, (current) =>
            current?.status === FILE_STATUS.pending ? { ...current, activeProbeJobId: probeJobId } : current,
        );
        try {
            await jobService.createPending(JOB_TYPE.PROBE_FILE, { fileId }, probeJobId);
        } catch (error) {
            await db.update(COLLECTION.files, fileId, (current) =>
                current?.status === FILE_STATUS.pending && current.activeProbeJobId === probeJobId
                    ? {
                          ...current,
                          status: FILE_STATUS.failed,
                          activeProbeJobId: null,
                          errorMessage: `Could not enqueue probe: ${error.message}`,
                      }
                    : current,
            );
            return getResult(false, `could_not_requeue: ${error.message}`);
        }
        eventService.wakeup();
        loggingService.log("api", `requeue ${file.path}`);
        return getResult(true, "file_requeued");
    });
}

export async function transitionFileToStopped(
    fileId,
    {
        withCriticalSection = processingService.withFileLifecycleCriticalSection,
        getFile = (id) => db.get(COLLECTION.files, id),
        updateFile = (id, updateFn) => db.update(COLLECTION.files, id, updateFn),
        getOutstandingJobs = jobService.listOutstandingForFile,
    } = {},
) {
    return withCriticalSection(fileId, async () => {
        const file = await getFile(fileId);
        if (!file) {
            return { error: "file_not_found" };
        }
        const error = stopFailureForFile(file);
        if (error) {
            return { error };
        }

        // This owner is captured in the same lifecycle section as the stopped mutation. Dispatch
        // cannot publish a newer owner between this read and the write/exclusion decision.
        const activeJobId = file.activeJobId || null;
        const activeProbeJobId = file.activeProbeJobId || null;
        const outstandingJobIds = (await getOutstandingJobs(fileId))
            .map((job) => job.jobId)
            .filter((jobId) => jobId !== activeJobId);
        await updateFile(fileId, (current) => ({
            ...current,
            status: FILE_STATUS.stopped,
            cancelled: Boolean(activeJobId),
            activeProbeJobId: null,
        }));
        return { activeJobId, activeProbeJobId, outstandingJobIds, path: file.path };
    });
}

export async function stop(
    fileId,
    {
        transition = transitionFileToStopped,
        failJob = jobService.failIfActive,
        wakeup = eventService.wakeup,
        log = loggingService.log,
    } = {},
) {
    const stopped = await transition(fileId);
    if (stopped.error) {
        return getResult(false, stopped.error);
    }

    // Preserve the freshly captured active transcode generation. Its cancellation result owns
    // journal/output cleanup. Fail only IDs snapshotted under the lifecycle lock: a concurrent
    // requeue may publish a new probe after that lock is released and must never be caught here.
    const jobsToFail = new Set(stopped.outstandingJobIds || []);
    if (stopped.activeProbeJobId) {
        jobsToFail.add(stopped.activeProbeJobId);
    }
    for (const jobId of jobsToFail) {
        await failJob(jobId, "Stopped by user");
    }
    if (stopped.activeJobId) {
        wakeup();
    }
    log("api", `stop ${stopped.path}`);
    return getResult(true, "file_stopped");
}
