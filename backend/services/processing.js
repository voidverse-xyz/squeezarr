import { stat, unlink, rename } from "fs/promises";
import * as db from "../database/index.js";
import * as jobService from "./job.js";
import * as logging from "./logging.js";
import { deriveAggregateStatus, mergeTranscodeResult, upsertTranscodeResult } from "./ffmpeg/results.js";
import { COLLECTION, FILE_STATUS, JOB_STATUS, RESULT_STATUS } from "shared/domain.js";

// Wider lifecycle protocols for one file are serialized in-process across file state, job state,
// and filesystem effects. The database facade separately serializes each document mutation to
// prevent stale replacement. When both layers are needed, lock order is this file section first,
// then a job mutation; a job callback must never wait for the same file section. No cross-instance
// locking is involved (the monitor is deliberately single-process).
const lifecycleTails = new Map();

export async function withFileLifecycleCriticalSection(fileId, operation) {
    const previous = lifecycleTails.get(fileId) || Promise.resolve();
    let releaseTurn;
    const turn = new Promise((resolve) => {
        releaseTurn = resolve;
    });
    const tail = previous.then(() => turn);
    lifecycleTails.set(fileId, tail);
    await previous;
    try {
        return await operation();
    } finally {
        releaseTurn();
        if (lifecycleTails.get(fileId) === tail) {
            lifecycleTails.delete(fileId);
        }
    }
}

export async function updateFileLifecycle(fileId, updateFn, updateDocument = db.update) {
    return withFileLifecycleCriticalSection(fileId, () => updateDocument(COLLECTION.files, fileId, updateFn));
}

export async function recomputeFileStatus(
    fileId,
    { ignoreActiveJobId = null } = {},
    {
        withCriticalSection = withFileLifecycleCriticalSection,
        listActiveJobs = (id) => jobService.listActiveTranscodesForFile(id),
        updateFile = (id, updateFn) => db.update(COLLECTION.files, id, updateFn),
    } = {},
) {
    // Keep the active-job snapshot and aggregate write in one file generation. This takes no job
    // mutation lock: ordering remains file lifecycle section → snapshot reads → file mutation.
    return withCriticalSection(fileId, async () => {
        const activeJobs = (await listActiveJobs(fileId)).filter((activeJob) => activeJob.jobId !== ignoreActiveJobId);
        let status = null;
        await updateFile(fileId, (file) => {
            if (!file) {
                return file;
            }
            const aggregateFile = file.activeJobId === ignoreActiveJobId ? { ...file, activeJobId: null } : file;
            status = deriveAggregateStatus(aggregateFile, activeJobs);
            return {
                ...file,
                status,
                errorMessage: status === FILE_STATUS.failed ? file.errorMessage : null,
            };
        });
        return status;
    });
}

export async function inspectFileLifecycle(fileId, inspect, getFile = (id) => db.get(COLLECTION.files, id)) {
    return withFileLifecycleCriticalSection(fileId, async () => inspect(await getFile(fileId)));
}

export function preparedTaskMatches(file, job, prepared) {
    return Boolean(
        file &&
        job?.status === JOB_STATUS.running &&
        file.status === FILE_STATUS.processing &&
        !file.cancelled &&
        file.activePhase === "processing" &&
        file.activeJobId === job.jobId &&
        file.activeSettingId === job.payload?.settingId &&
        file.currentOutputPath === job.preparedOutputPath &&
        prepared?.fileId === file.fileId &&
        prepared.outputPath === job.preparedOutputPath,
    );
}

export async function validatePreparedTask(jobId, prepared) {
    return inspectFileLifecycle(prepared.fileId, async (file) =>
        preparedTaskMatches(file, await jobService.get(jobId), prepared),
    );
}

export function probeOwnerNeedsRecovery(file, probeJob) {
    return Boolean(
        file?.activeProbeJobId && (!probeJob || ![JOB_STATUS.pending, JOB_STATUS.running].includes(probeJob.status)),
    );
}

export async function recoverProbeOwners({
    getFiles = () => db.getAll(COLLECTION.files),
    getJob = (jobId) => jobService.get(jobId),
    clearOwner = (fileId, probeJobId) =>
        updateFileLifecycle(fileId, (file) =>
            file?.activeProbeJobId === probeJobId ? { ...file, activeProbeJobId: null } : file,
        ),
} = {}) {
    const files = await getFiles();
    let recovered = 0;
    for (const file of files) {
        if (!file.activeProbeJobId) {
            continue;
        }
        const probeJob = await getJob(file.activeProbeJobId);
        if (!probeOwnerNeedsRecovery(file, probeJob)) {
            continue;
        }
        await clearOwner(file.fileId, file.activeProbeJobId);
        recovered++;
    }
    if (recovered > 0) {
        logging.log("recover", `cleared ${recovered} orphaned probe owner(s)`);
    }
    return recovered;
}

export async function initialize() {
    await recoverProbeOwners();
    await recoverAdjacentJournals();
    await recoverOverwriteJournals();
    await recoverStuckFiles();
}

export async function hasActiveOwner(fileId) {
    const file = await db.get(COLLECTION.files, fileId);
    return Boolean(file?.activeJobId);
}

export function isOwner(file, jobId, settingId) {
    return Boolean(file && file.activeJobId === jobId && (!settingId || file.activeSettingId === settingId));
}

export async function getOwnedFile(fileId, jobId, settingId) {
    const file = await db.get(COLLECTION.files, fileId);
    return isOwner(file, jobId, settingId) ? file : null;
}

// Conditional lifecycle transition used at each side-effect boundary. A stop changes cancelled
// and status, so requireActive also fences a finalizer after stop has been acknowledged.
export async function transitionOwner(fileId, jobId, patch, { requireActive = false } = {}) {
    return withFileLifecycleCriticalSection(fileId, async () => {
        let transitioned = false;
        await db.update(COLLECTION.files, fileId, (file) => {
            if (!isOwner(file, jobId) || (requireActive && (file.cancelled || file.status === FILE_STATUS.stopped))) {
                return file;
            }
            transitioned = true;
            return { ...file, ...patch };
        });
        return transitioned;
    });
}

export async function cancel(fileId, jobId = null) {
    return withFileLifecycleCriticalSection(fileId, async () => {
        let cancelled = false;
        await db.update(COLLECTION.files, fileId, (file) => {
            if (!file || (jobId && file.activeJobId !== jobId) || file.activePhase === "committing") {
                return file;
            }
            cancelled = true;
            return {
                ...file,
                status: FILE_STATUS.stopped,
                cancelled: Boolean(file.activeJobId),
            };
        });
        return cancelled;
    });
}

export function terminalOwnerCanRelease(file, job) {
    const hasResult = (file?.transcodeResults || []).some((result) => result.settingId === file?.activeSettingId);
    const adjacentSettled = !file?.adjacentJournal || file.adjacentJournal.phase === "cleaned";
    const overwriteSettled = !file?.overwriteJournal || file.overwriteJournal.phase === "cleaned";
    return Boolean(
        file?.activeJobId === job?.jobId &&
        file.activePhase === "committing" &&
        ![FILE_STATUS.processing, FILE_STATUS.stopped].includes(file.status) &&
        job.status === JOB_STATUS.done &&
        hasResult &&
        adjacentSettled &&
        overwriteSettled,
    );
}

export function failedOwnerCanRelease(file, job, { preserveOutputPath = false } = {}) {
    const failedResult = (file?.transcodeResults || []).some(
        (result) => result.settingId === file?.activeSettingId && result.status === RESULT_STATUS.failed,
    );
    const journalSettled =
        !file?.adjacentJournal && !file?.overwriteJournal && !file?.currentOutputPath && !file?.reservedOutputPath;
    const cleanupJournalIds = [file?.adjacentJournal?.jobId, file?.overwriteJournal?.jobId].filter(Boolean);
    const cleanupRetained = Boolean(
        preserveOutputPath &&
        file?.currentOutputPath &&
        cleanupJournalIds.length > 0 &&
        cleanupJournalIds.every((id) => id === job?.jobId),
    );
    return Boolean(
        file?.activeJobId === job?.jobId &&
        file.activePhase === "committing" &&
        ![FILE_STATUS.processing, FILE_STATUS.stopped].includes(file.status) &&
        job.status === JOB_STATUS.failed &&
        failedResult &&
        (journalSettled || cleanupRetained),
    );
}

export async function releaseFailedOwner(fileId, jobId, { preserveOutputPath = false } = {}) {
    return withFileLifecycleCriticalSection(fileId, async () => {
        const job = await jobService.get(jobId);
        let released = false;
        await db.update(COLLECTION.files, fileId, (file) => {
            if (!failedOwnerCanRelease(file, job, { preserveOutputPath })) {
                return file;
            }
            released = true;
            return {
                ...file,
                cancelled: false,
                activeJobId: null,
                activeSettingId: null,
                activePhase: null,
                failureMessage: null,
                currentOutputPath: preserveOutputPath ? file.currentOutputPath : null,
                reservedOutputPath: preserveOutputPath ? file.reservedOutputPath : null,
                processingStartedAt: null,
            };
        });
        return released;
    });
}

export async function releaseTerminalOwner(fileId, jobId, { preserveOutputPath = false } = {}) {
    return withFileLifecycleCriticalSection(fileId, async () => {
        const job = await jobService.get(jobId);
        let released = false;
        await db.update(COLLECTION.files, fileId, (file) => {
            if (!terminalOwnerCanRelease(file, job)) {
                return file;
            }
            released = true;
            return {
                ...file,
                cancelled: false,
                activeJobId: null,
                activeSettingId: null,
                activePhase: null,
                failureMessage: null,
                currentOutputPath: preserveOutputPath ? file.currentOutputPath : null,
                reservedOutputPath: preserveOutputPath ? file.reservedOutputPath : null,
                processingStartedAt: null,
            };
        });
        return released;
    });
}

export async function release(fileId, jobId = null, { preserveOutputPath = false } = {}) {
    return withFileLifecycleCriticalSection(fileId, async () => {
        let released = false;
        await db.update(COLLECTION.files, fileId, (file) => {
            if (!file || (jobId && file.activeJobId !== jobId)) {
                return file;
            }
            released = true;
            return {
                ...file,
                cancelled: false,
                activeJobId: null,
                activeSettingId: null,
                activePhase: null,
                failureMessage: null,
                currentOutputPath: preserveOutputPath ? file.currentOutputPath : null,
                reservedOutputPath: preserveOutputPath ? file.reservedOutputPath : null,
                processingStartedAt: null,
            };
        });
        return released;
    });
}

async function sameFileIdentity(firstPath, secondPath) {
    try {
        const [first, second] = await Promise.all([stat(firstPath), stat(secondPath)]);
        return first.dev === second.dev && first.ino === second.ino;
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function pathExists(filePath) {
    if (!filePath) {
        return false;
    }
    try {
        await stat(filePath);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function removeIfPresent(filePath) {
    if (!filePath) {
        return true;
    }
    try {
        await unlink(filePath);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            return true;
        }
        throw error;
    }
}

export function adjacentRecoveryAction(journal) {
    return journal && ["committed", "cleaned"].includes(journal.phase) ? "roll-forward" : "roll-back";
}

export async function reconcileAdjacentFilesystem(journal, action) {
    if (action === "roll-back") {
        // A promoting journal may have linked scratch to final before crashing. Remove the final
        // only when inode identity proves it belongs to this task; an unrelated collision survives.
        if (await sameFileIdentity(journal.scratchPath, journal.finalPath)) {
            await removeIfPresent(journal.finalPath);
        }
        await removeIfPresent(journal.scratchPath);
        return;
    }
    await removeIfPresent(journal.scratchPath);
}

export function interruptedRecoveryStatus(file) {
    return file?.status === FILE_STATUS.stopped || file?.cancelled ? FILE_STATUS.stopped : FILE_STATUS.queued;
}

export function isFailureFinalizing(file, journal) {
    return Boolean(file?.activeJobId === journal?.jobId && file.activePhase === "committing" && file.failureMessage);
}

async function recoverFailureFinalization(file, journal, journalType) {
    if (journalType === "adjacent") {
        await reconcileAdjacentFilesystem(journal, "roll-back");
    } else {
        await reconcileOverwriteFilesystem(journal, "roll-back");
    }

    const failedResult = {
        settingId: journal.settingId || file.activeSettingId,
        settingName: journal.settingName || journal.settingId || file.activeSettingId,
        inputPath: journal.inputPath || journal.sourcePath || file.path,
        inputSize: journal.inputSize ?? file.size,
        outputPath: null,
        outputSize: 0,
        outputMode: journal.outputMode,
        status: RESULT_STATUS.failed,
        error: file.failureMessage,
        completedAt: Date.now(),
    };
    let persisted = false;
    await updateFileLifecycle(file.fileId, (current) => {
        if (!isFailureFinalizing(current, journal)) {
            return current;
        }
        persisted = true;
        return {
            ...mergeTranscodeResult(current, failedResult),
            errorMessage: current.failureMessage,
            adjacentJournal: journalType === "adjacent" ? null : current.adjacentJournal,
            overwriteJournal: journalType === "overwrite" ? null : current.overwriteJournal,
            currentOutputPath: null,
            reservedOutputPath: null,
        };
    });
    if (!persisted) {
        return false;
    }
    await jobService.failIfActive(journal.jobId, file.failureMessage);
    await recomputeFileStatus(file.fileId, { ignoreActiveJobId: journal.jobId });
    if (!(await releaseFailedOwner(file.fileId, journal.jobId))) {
        throw new Error("Recovered failed ownership was not durable before release");
    }
    return true;
}

async function rollBackAdjacent(file, journal) {
    await reconcileAdjacentFilesystem(journal, "roll-back");
    await jobService.failIfActive(journal.jobId, "Interrupted during adjacent output promotion");
    const status = interruptedRecoveryStatus(file);
    await updateFileLifecycle(file.fileId, (current) =>
        current
            ? {
                  ...current,
                  status,
                  cancelled: false,
                  adjacentJournal: null,
                  currentOutputPath: null,
                  reservedOutputPath: null,
              }
            : current,
    );
    await release(file.fileId, journal.jobId);
    if (status !== FILE_STATUS.stopped) {
        await recomputeFileStatus(file.fileId);
    }
}

export function recoveredOwnerNeedsRelease(file, journal) {
    return file?.activeJobId === journal?.jobId;
}

async function rollForwardAdjacent(file, journal) {
    const outputStat = await stat(journal.finalPath);
    await upsertTranscodeResult(file.fileId, {
        settingId: journal.settingId,
        settingName: journal.settingName,
        inputPath: journal.inputPath,
        inputSize: journal.inputSize,
        outputPath: journal.finalPath,
        outputSize: journal.outputSize ?? outputStat.size,
        outputMode: journal.outputMode,
        status: journal.resultStatus || RESULT_STATUS.done,
        rejectedBy: journal.rejectedBy || null,
        completedAt: journal.completedAt || Date.now(),
    });
    await jobService.completeIfRunning(journal.jobId);
    await recomputeFileStatus(file.fileId, { ignoreActiveJobId: journal.jobId });
    await db.patch(COLLECTION.files, file.fileId, {
        adjacentJournal: { ...journal, phase: "cleaned" },
    });
    try {
        // `cleaned` means the success/result state is terminal and only idempotent scratch cleanup
        // remains. Keep this journal until the filesystem operation actually succeeds.
        await reconcileAdjacentFilesystem(journal, "roll-forward");
    } catch (error) {
        await db.patch(COLLECTION.files, file.fileId, {
            currentOutputPath: journal.scratchPath,
            reservedOutputPath: journal.finalPath,
            errorMessage: `Adjacent scratch cleanup failed: ${error.message}`,
        });
        logging.error("recover", `adjacent scratch cleanup ${journal.scratchPath}: ${error.message}`);
        const retained = await db.get(COLLECTION.files, file.fileId);
        if (
            recoveredOwnerNeedsRelease(retained, journal) &&
            !(await releaseTerminalOwner(file.fileId, journal.jobId, { preserveOutputPath: true }))
        ) {
            throw new Error("Recovered adjacent cleanup ownership was not durable before release");
        }
        return;
    }

    // Clear only after scratch cleanup. A crash before this patch leaves an idempotently retryable
    // cleaned journal; a previously released owner needs no second release-gate success.
    await db.patch(COLLECTION.files, file.fileId, {
        adjacentJournal: null,
        currentOutputPath: null,
        reservedOutputPath: null,
    });
    const current = await db.get(COLLECTION.files, file.fileId);
    if (recoveredOwnerNeedsRelease(current, journal) && !(await releaseTerminalOwner(file.fileId, journal.jobId))) {
        throw new Error("Recovered adjacent terminal ownership was not durable before release");
    }
}

export async function recoverAdjacentJournal(file) {
    const journal = file?.adjacentJournal;
    if (!journal) {
        return false;
    }
    if (isFailureFinalizing(file, journal)) {
        await recoverFailureFinalization(file, journal, "adjacent");
        return true;
    }
    if (adjacentRecoveryAction(journal) === "roll-forward") {
        await rollForwardAdjacent(file, journal);
    } else {
        await rollBackAdjacent(file, journal);
    }
    return true;
}

export async function recoverAdjacentJournals() {
    const files = await db.getAll(COLLECTION.files);
    let recovered = 0;
    for (const file of files) {
        if (!file.adjacentJournal) {
            continue;
        }
        try {
            if (await recoverAdjacentJournal(file)) {
                recovered++;
            }
        } catch (error) {
            await db.patch(COLLECTION.files, file.fileId, {
                status:
                    interruptedRecoveryStatus(file) === FILE_STATUS.stopped ? FILE_STATUS.stopped : FILE_STATUS.failed,
                currentOutputPath: file.adjacentJournal.scratchPath,
                reservedOutputPath: file.adjacentJournal.finalPath,
                errorMessage: `Adjacent recovery failed: ${error.message}`,
            });
            logging.error("recover", `adjacent journal ${file.fileId}: ${error.message}`);
        }
    }
    if (recovered > 0) {
        logging.log("recover", `reconciled ${recovered} adjacent journal(s)`);
    }
}

export async function reconcileOverwriteFilesystem(
    journal,
    action,
    operations = { pathExists, rename, removeIfPresent },
) {
    if (action === "roll-back") {
        if (await operations.pathExists(journal.backupPath)) {
            await operations.rename(journal.backupPath, journal.sourcePath);
        }
        await operations.removeIfPresent(journal.tempPath);
        return;
    }
    await operations.removeIfPresent(journal.backupPath);
}

async function rollBackOverwrite(file, journal) {
    await reconcileOverwriteFilesystem(journal, "roll-back");
    await jobService.failIfActive(journal.jobId, "Interrupted during overwrite replacement");
    const status = interruptedRecoveryStatus(file);
    await updateFileLifecycle(file.fileId, (current) =>
        current
            ? {
                  ...current,
                  status,
                  cancelled: false,
                  overwriteJournal: null,
                  currentOutputPath: null,
              }
            : current,
    );
    await release(file.fileId, journal.jobId);
    if (status !== FILE_STATUS.stopped) {
        await recomputeFileStatus(file.fileId);
    }
}

async function rollForwardOverwrite(file, journal) {
    const outputStat = await stat(journal.sourcePath);
    await upsertTranscodeResult(file.fileId, {
        settingId: journal.settingId,
        settingName: journal.settingName,
        inputPath: journal.sourcePath,
        inputSize: journal.inputSize,
        outputPath: null,
        outputSize: journal.outputSize ?? outputStat.size,
        outputMode: journal.outputMode,
        status: RESULT_STATUS.replaced,
        completedAt: journal.completedAt || Date.now(),
    });
    await db.patch(COLLECTION.files, file.fileId, {
        status: FILE_STATUS.replaced,
        replaced: true,
        replacedAt: journal.replacedAt || new Date().toISOString(),
        processedAt: journal.completedAt || Date.now(),
        size: journal.outputSize ?? outputStat.size,
    });
    await jobService.completeIfRunning(journal.jobId);
    await db.patch(COLLECTION.files, file.fileId, {
        overwriteJournal: { ...journal, phase: "cleaned" },
    });
    await reconcileOverwriteFilesystem(journal, "roll-forward");
    await release(file.fileId, journal.jobId);
    await db.patch(COLLECTION.files, file.fileId, { overwriteJournal: null, currentOutputPath: null });
}

export function overwriteRecoveryAction(journal) {
    return journal && ["committed", "cleaned"].includes(journal.phase) ? "roll-forward" : "roll-back";
}

export async function recoverOverwriteJournal(file) {
    const journal = file?.overwriteJournal;
    if (!journal) {
        return false;
    }
    if (isFailureFinalizing(file, journal)) {
        await recoverFailureFinalization(file, journal, "overwrite");
        return true;
    }

    if (overwriteRecoveryAction(journal) === "roll-forward") {
        await rollForwardOverwrite(file, journal);
    } else {
        // prepared/replacing are uncommitted. If source movement started, the retained backup is
        // authoritative and rename atomically restores it over any uncommitted replacement.
        await rollBackOverwrite(file, journal);
    }
    return true;
}

export async function recoverOverwriteJournals() {
    const files = await db.getAll(COLLECTION.files);
    let recovered = 0;
    for (const file of files) {
        if (!file.overwriteJournal) {
            continue;
        }
        try {
            if (await recoverOverwriteJournal(file)) {
                recovered++;
            }
        } catch (error) {
            // Keep journal/path ownership intact. Forgetting it would let the scanner ingest a
            // surviving temporary/backup output as a source.
            const backupSurvives = await pathExists(file.overwriteJournal.backupPath).catch(() => false);
            await db.patch(COLLECTION.files, file.fileId, {
                status:
                    interruptedRecoveryStatus(file) === FILE_STATUS.stopped ? FILE_STATUS.stopped : FILE_STATUS.failed,
                currentOutputPath: backupSurvives ? file.overwriteJournal.backupPath : file.overwriteJournal.tempPath,
                errorMessage: `Overwrite recovery failed: ${error.message}`,
            });
            logging.error("recover", `overwrite journal ${file.fileId}: ${error.message}`);
        }
    }
    if (recovered > 0) {
        logging.log("recover", `reconciled ${recovered} overwrite journal(s)`);
    }
}

// Startup recovery is conditional on the persisted owner. Overwrite journals were reconciled
// first, so an already-replaced source is never blindly put back through the lossy pipeline.
export async function recoverStuckFiles() {
    const allFiles = await db.getAll(COLLECTION.files);
    let recovered = 0;
    for (const file of allFiles) {
        if (file.activeJobId && file.activePhase === "committing" && !file.overwriteJournal && !file.adjacentJournal) {
            let terminalCleanupReady = true;
            if (file.currentOutputPath) {
                try {
                    await removeIfPresent(file.currentOutputPath);
                    await db.patch(COLLECTION.files, file.fileId, {
                        currentOutputPath: null,
                        reservedOutputPath: null,
                    });
                } catch (error) {
                    terminalCleanupReady = false;
                    await db.patch(COLLECTION.files, file.fileId, {
                        errorMessage: `Output cleanup failed: ${error.message}`,
                    });
                }
            }
            if (terminalCleanupReady && file.failureMessage) {
                // Journal/result cleanup is atomic for failure recovery. With no journal left, a
                // crash here means the failed result is already durable; finish the remaining job
                // and aggregate milestones before applying the failure-specific release gate.
                await jobService.failIfActive(file.activeJobId, file.failureMessage);
                await recomputeFileStatus(file.fileId, { ignoreActiveJobId: file.activeJobId });
            }
            const released =
                terminalCleanupReady &&
                (file.failureMessage
                    ? await releaseFailedOwner(file.fileId, file.activeJobId)
                    : (await releaseTerminalOwner(file.fileId, file.activeJobId)) ||
                      (await releaseFailedOwner(file.fileId, file.activeJobId)));
            if (released) {
                recovered++;
                continue;
            }
        }
        if (
            ![FILE_STATUS.processing, FILE_STATUS.stopped].includes(file.status) ||
            file.overwriteJournal ||
            file.adjacentJournal
        ) {
            continue;
        }

        let cleaned = true;
        try {
            await removeIfPresent(file.currentOutputPath);
        } catch (error) {
            cleaned = false;
            await db.patch(COLLECTION.files, file.fileId, { errorMessage: `Output cleanup failed: ${error.message}` });
        }
        if (!file.activeJobId) {
            // Defense in depth for legacy/crash residue from a release-before-finalization window.
            // Keep failed cleanup in processing so startup retries it and destructive actions stay
            // fenced by the residue; a successful cleanup can safely return to aggregate state.
            if (cleaned) {
                await db.patch(COLLECTION.files, file.fileId, {
                    status: FILE_STATUS.queued,
                    currentOutputPath: null,
                    reservedOutputPath: null,
                    processingStartedAt: null,
                });
                await recomputeFileStatus(file.fileId);
            }
            recovered++;
            continue;
        }

        await jobService.failIfActive(file.activeJobId, "Interrupted by server restart");
        await release(file.fileId, file.activeJobId, { preserveOutputPath: !cleaned });
        if (file.status === FILE_STATUS.stopped) {
            await db.patch(COLLECTION.files, file.fileId, { status: FILE_STATUS.stopped, cancelled: false });
        } else {
            await recomputeFileStatus(file.fileId);
        }
        recovered++;
    }

    if (recovered > 0) {
        logging.log("recover", `reset ${recovered} stuck file(s)`);
    }
}
