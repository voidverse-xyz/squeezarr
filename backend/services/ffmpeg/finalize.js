// Monitor-side finalization. Every filesystem or terminal transition is fenced by the persisted
// job owner and prepared output path; jobId is the task generation.
import { constants } from "fs";
import { access, lstat, stat, unlink, rename, link } from "fs/promises";
import * as db from "../../database/index.js";
import * as settings from "../settings.js";
import * as jobService from "../job.js";
import * as processing from "../processing.js";
import * as logging from "../logging.js";
import { runFilters } from "../filters.js";
import { resolveSetting } from "./shared.js";
import { buildResult, mergeTranscodeResult, upsertTranscodeResult } from "./results.js";
import { COLLECTION, FILE_STATUS, RESULT_STATUS, OUTPUT_MODE } from "shared/domain.js";

async function removeOwnedOutput(outputPath) {
    if (!outputPath) {
        return true;
    }
    try {
        await unlink(outputPath);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            return true;
        }
        throw error;
    }
}

export async function validateOutput(outputPath) {
    if (!outputPath) {
        throw new Error("Runner did not have a persisted output path");
    }
    const outputStat = await lstat(outputPath);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) {
        throw new Error(`Expected output is not a regular file: ${outputPath}`);
    }
    await access(outputPath, constants.R_OK);
    return outputStat;
}

async function cleanupOwnedOutput(file, outputPath) {
    try {
        await removeOwnedOutput(outputPath);
        return true;
    } catch (error) {
        await db.patch(COLLECTION.files, file.fileId, { errorMessage: `Output cleanup failed: ${error.message}` });
        logging.error("transcode", `could not clean ${outputPath}: ${error.message}`);
        return false;
    }
}

async function finishStopped(file, job) {
    const cleaned = await cleanupOwnedOutput(file, job.preparedOutputPath);
    await processing.updateFileLifecycle(file.fileId, (current) => {
        if (current?.activeJobId !== job.jobId) {
            return current;
        }
        return {
            ...current,
            status: FILE_STATUS.stopped,
            cancelled: false,
            ...(cleaned
                ? {
                      overwriteJournal: null,
                      adjacentJournal: null,
                      currentOutputPath: null,
                      reservedOutputPath: null,
                  }
                : {}),
        };
    });
    await jobService.completeIfRunning(job.jobId);
    // Release last. If the process crashes after journal cleanup, startup recovery recognizes and
    // releases the stopped owner without ever requeueing it.
    await processing.release(file.fileId, job.jobId, { preserveOutputPath: !cleaned });
}

async function finishFailure(ctx, message) {
    const { file, setting, settingId, job, outputPath } = ctx;
    const current = await processing.getOwnedFile(file.fileId, job.jobId, settingId);
    if (!current) {
        return false;
    }
    if (current.status === FILE_STATUS.stopped || current.cancelled) {
        await finishStopped(current, job);
        return true;
    }

    // Failure is a terminal commit too: once claimed, Stop cannot acknowledge and requeue cannot
    // publish a new generation until every old-generation write is durable and ownership releases.
    if (
        !(await processing.transitionOwner(
            file.fileId,
            job.jobId,
            { activePhase: "committing", failureMessage: message },
            { requireActive: true },
        ))
    ) {
        const stopped = await processing.getOwnedFile(file.fileId, job.jobId, settingId);
        if (stopped) {
            await finishStopped(stopped, job);
        }
        return true;
    }

    let cleaned = true;
    let cleanupError = null;
    try {
        await removeOwnedOutput(outputPath);
    } catch (error) {
        cleaned = false;
        cleanupError = error;
        logging.error("transcode", `could not clean ${outputPath}: ${error.message}`);
    }

    const resultSetting = setting || {
        name: current.adjacentJournal?.settingName || current.overwriteJournal?.settingName || settingId,
        outputMode: current.adjacentJournal?.outputMode || current.overwriteJournal?.outputMode || job.outputMode,
    };
    const failedResult = buildResult(
        { file, setting: resultSetting, settingId },
        { outputPath: null, outputSize: 0, status: RESULT_STATUS.failed, error: message },
    );
    let persisted = false;
    await processing.updateFileLifecycle(file.fileId, (owned) => {
        if (!processing.isOwner(owned, job.jobId, settingId) || owned.activePhase !== "committing") {
            return owned;
        }
        persisted = true;
        const withResult = mergeTranscodeResult(owned, failedResult);
        return {
            ...withResult,
            errorMessage: cleanupError ? `Output cleanup failed: ${cleanupError.message}` : message,
            ...(cleaned
                ? {
                      overwriteJournal: null,
                      adjacentJournal: null,
                      currentOutputPath: null,
                      reservedOutputPath: null,
                  }
                : {}),
        };
    });
    if (!persisted) {
        return false;
    }

    await jobService.failIfActive(job.jobId, message);
    await processing.recomputeFileStatus(file.fileId, { ignoreActiveJobId: job.jobId });
    if (!(await processing.releaseFailedOwner(file.fileId, job.jobId, { preserveOutputPath: !cleaned }))) {
        throw new Error("Failed terminal ownership was not durable before release");
    }
    logging.error("transcode", `failed ${file.path}${setting ? ` ("${setting.name}")` : ""}: ${message}`);
    return true;
}

export async function promoteAdjacentScratch(scratchPath, finalPath, linkFile = link) {
    await linkFile(scratchPath, finalPath);
    return validateOutput(finalPath);
}

async function finishAdjacentOutput(ctx, resultStatus, rejectedBy = null) {
    const { file, setting, settingId, job, outputPath, finalOutputPath } = ctx;
    const journal = file.adjacentJournal;
    if (
        !journal ||
        journal.jobId !== job.jobId ||
        journal.scratchPath !== outputPath ||
        journal.finalPath !== finalOutputPath
    ) {
        throw new Error("Adjacent output journal does not match the active task");
    }

    const promotingJournal = { ...journal, phase: "promoting", resultStatus, rejectedBy };
    const claimedCommit = await processing.transitionOwner(
        file.fileId,
        job.jobId,
        { activePhase: "committing", adjacentJournal: promotingJournal },
        { requireActive: true },
    );
    if (!claimedCommit) {
        const stopped = await processing.getOwnedFile(file.fileId, job.jobId, settingId);
        if (stopped) {
            await finishStopped(stopped, job);
        }
        return null;
    }

    // Hard-link promotion is same-filesystem and fails with EEXIST rather than replacing an
    // unrelated late collision. The scratch link is removed only after durable result state.
    const outputStat = await promoteAdjacentScratch(outputPath, finalOutputPath);
    const completedAt = Date.now();
    const committedJournal = {
        ...promotingJournal,
        phase: "committed",
        outputSize: outputStat.size,
        completedAt,
    };
    await processing.transitionOwner(file.fileId, job.jobId, { adjacentJournal: committedJournal });
    await upsertTranscodeResult(
        file.fileId,
        buildResult(
            { file, setting, settingId },
            { outputPath: finalOutputPath, outputSize: outputStat.size, status: resultStatus, rejectedBy, completedAt },
        ),
    );
    await db.patch(COLLECTION.files, file.fileId, { processedAt: completedAt });
    await jobService.completeIfRunning(job.jobId);
    await processing.recomputeFileStatus(file.fileId, { ignoreActiveJobId: job.jobId });
    await db.patch(COLLECTION.files, file.fileId, {
        adjacentJournal: { ...committedJournal, phase: "cleaned" },
    });
    let cleanupFailed = false;
    try {
        await removeOwnedOutput(outputPath);
        await db.patch(COLLECTION.files, file.fileId, {
            adjacentJournal: null,
            currentOutputPath: null,
            reservedOutputPath: null,
        });
    } catch (error) {
        cleanupFailed = true;
        await db.patch(COLLECTION.files, file.fileId, {
            currentOutputPath: outputPath,
            reservedOutputPath: finalOutputPath,
            errorMessage: `Adjacent scratch cleanup failed: ${error.message}`,
        });
        logging.error("transcode", `adjacent scratch cleanup ${outputPath}: ${error.message}`);
    }
    // Keep the committing owner until result, job, aggregate status, and journal cleanup state
    // are durable. Stop cannot be acknowledged inside that irreversible window.
    if (!(await processing.releaseTerminalOwner(file.fileId, job.jobId, { preserveOutputPath: cleanupFailed }))) {
        throw new Error("Adjacent terminal ownership was not durable before release");
    }
    return outputStat.size;
}

async function finishRejected(ctx, rejectedBy) {
    const { file, setting, settingId, job, outputPath } = ctx;
    if (!ctx.isOverwrite && !setting.deleteOnReject) {
        await finishAdjacentOutput(ctx, RESULT_STATUS.rejected, rejectedBy);
        logging.log("transcode", `rejected ${file.path} ("${setting.name}") by filter "${rejectedBy}"`);
        return;
    }

    let keptOutputPath = outputPath;
    let outputSize = (await validateOutput(outputPath)).size;
    if (setting.deleteOnReject) {
        await removeOwnedOutput(outputPath);
        keptOutputPath = null;
        outputSize = 0;
    }

    await upsertTranscodeResult(
        file.fileId,
        buildResult(
            { file, setting, settingId },
            {
                outputPath: keptOutputPath,
                outputSize,
                status: RESULT_STATUS.rejected,
                rejectedBy,
            },
        ),
    );
    await jobService.completeIfRunning(job.jobId);
    await processing.recomputeFileStatus(file.fileId, { ignoreActiveJobId: job.jobId });
    if (file.overwriteJournal?.jobId === job.jobId || file.adjacentJournal?.jobId === job.jobId) {
        await db.patch(COLLECTION.files, file.fileId, {
            overwriteJournal: null,
            adjacentJournal: null,
            reservedOutputPath: null,
        });
    }
    if (!(await processing.releaseTerminalOwner(file.fileId, job.jobId))) {
        throw new Error("Rejected terminal ownership was not durable before release");
    }
    logging.log("transcode", `rejected ${file.path} ("${setting.name}") by filter "${rejectedBy}"`);
}

async function finishAdjacentSuccess(ctx) {
    return finishAdjacentOutput(ctx, RESULT_STATUS.done);
}

async function finishOverwriteSuccess(ctx) {
    const { file, setting, settingId, job, outputPath } = ctx;
    const journal = file.overwriteJournal;
    if (!journal || journal.jobId !== job.jobId || journal.tempPath !== outputPath) {
        throw new Error("Overwrite journal does not match the active task");
    }

    const replacingJournal = { ...journal, phase: "replacing" };
    const claimedCommit = await processing.transitionOwner(
        file.fileId,
        job.jobId,
        { activePhase: "committing", overwriteJournal: replacingJournal },
        { requireActive: true },
    );
    if (!claimedCommit) {
        const stopped = await processing.getOwnedFile(file.fileId, job.jobId, settingId);
        if (stopped) {
            await finishStopped(stopped, job);
        }
        return null;
    }

    await rename(file.path, journal.backupPath);
    try {
        await rename(outputPath, file.path);
    } catch (error) {
        await rename(journal.backupPath, file.path).catch(() => {});
        throw error;
    }

    const outputStat = await stat(file.path);
    const completedAt = Date.now();
    const committedJournal = {
        ...replacingJournal,
        phase: "committed",
        outputSize: outputStat.size,
        completedAt,
        replacedAt: new Date().toISOString(),
    };
    const journalPersisted = await processing.transitionOwner(file.fileId, job.jobId, {
        overwriteJournal: committedJournal,
    });
    if (!journalPersisted) {
        throw new Error("Lost overwrite ownership before commit was persisted");
    }

    await upsertTranscodeResult(
        file.fileId,
        buildResult(
            { file, setting, settingId },
            { outputPath: null, outputSize: outputStat.size, status: RESULT_STATUS.replaced, completedAt },
        ),
    );
    await db.patch(COLLECTION.files, file.fileId, {
        status: FILE_STATUS.replaced,
        replaced: true,
        replacedAt: committedJournal.replacedAt,
        processedAt: completedAt,
        size: outputStat.size,
    });
    await jobService.completeIfRunning(job.jobId);
    await db.patch(COLLECTION.files, file.fileId, {
        overwriteJournal: { ...committedJournal, phase: "cleaned" },
    });

    // A failed backup cleanup is not allowed to erase its ownership journal. Startup recovery
    // retries it while preserving the already-durable replacement result.
    try {
        await removeOwnedOutput(journal.backupPath);
        if (!(await processing.releaseTerminalOwner(file.fileId, job.jobId))) {
            throw new Error("Overwrite terminal ownership was not durable before release");
        }
        await db.patch(COLLECTION.files, file.fileId, { overwriteJournal: null, currentOutputPath: null });
    } catch (error) {
        if (!(await processing.releaseTerminalOwner(file.fileId, job.jobId, { preserveOutputPath: true }))) {
            throw new Error("Overwrite terminal ownership was not durable before release");
        }
        await db.patch(COLLECTION.files, file.fileId, {
            currentOutputPath: journal.backupPath,
            errorMessage: `Backup cleanup failed: ${error.message}`,
        });
        logging.error("transcode", `backup cleanup ${journal.backupPath}: ${error.message}`);
    }
    return outputStat.size;
}

async function recoverFinalizationError(ctx, error) {
    const current = await db.get(COLLECTION.files, ctx.file.fileId);
    if (!processing.isOwner(current, ctx.job.jobId, ctx.settingId)) {
        return;
    }
    if (current.adjacentJournal) {
        try {
            const recoveryAction = processing.adjacentRecoveryAction(current.adjacentJournal);
            if (recoveryAction === "roll-back") {
                await processing.reconcileAdjacentFilesystem(current.adjacentJournal, "roll-back");
                await finishFailure({ ...ctx, file: current }, error.message);
            } else {
                await processing.recoverAdjacentJournal(current);
            }
            return;
        } catch (recoveryError) {
            await db.patch(COLLECTION.files, current.fileId, {
                status: FILE_STATUS.failed,
                errorMessage: `Finalization recovery failed: ${recoveryError.message}`,
            });
            await jobService.failIfActive(ctx.job.jobId, recoveryError.message);
            throw recoveryError;
        }
    }
    if (current.overwriteJournal) {
        try {
            const recoveryAction = processing.overwriteRecoveryAction(current.overwriteJournal);
            if (recoveryAction === "roll-back") {
                await processing.reconcileOverwriteFilesystem(current.overwriteJournal, "roll-back");
                await finishFailure({ ...ctx, file: current }, error.message);
            } else {
                await processing.recoverOverwriteJournal(current);
            }
            return;
        } catch (recoveryError) {
            await db.patch(COLLECTION.files, current.fileId, {
                status: FILE_STATUS.failed,
                errorMessage: `Finalization recovery failed: ${recoveryError.message}`,
            });
            await jobService.failIfActive(ctx.job.jobId, recoveryError.message);
            throw recoveryError;
        }
    }
    await finishFailure({ ...ctx, file: current }, error.message);
}

export async function finalizeTranscode(job, result) {
    const { fileId, settingId } = job.payload;
    const file = await db.get(COLLECTION.files, fileId);
    if (!processing.isOwner(file, job.jobId, settingId)) {
        return { ignored: true };
    }
    if (!job.preparedOutputPath || job.preparedOutputPath !== file.currentOutputPath) {
        return { ignored: true };
    }
    if (job.outputMode === OUTPUT_MODE.adjacent && job.finalOutputPath !== file.reservedOutputPath) {
        return { ignored: true };
    }

    const config = await settings.get();
    const setting = resolveSetting(config, settingId);
    const ctx = {
        file,
        setting,
        settingId,
        job,
        outputPath: job.preparedOutputPath,
        finalOutputPath: job.finalOutputPath,
        isOverwrite: job.outputMode === OUTPUT_MODE.overwrite,
    };

    try {
        if (!setting) {
            await finishFailure(ctx, "Transcode setting removed");
            return { failed: true };
        }
        if (result.cancelled === true || file.status === FILE_STATUS.stopped || file.cancelled) {
            await finishStopped(file, job);
            return { stopped: true };
        }
        if (result.error || result.exitCode !== 0) {
            await finishFailure(ctx, result.error || `FFmpeg exited with code ${result.exitCode}`);
            return { failed: true };
        }

        const finalizing = await processing.transitionOwner(
            fileId,
            job.jobId,
            { activePhase: "finalizing" },
            { requireActive: true },
        );
        if (!finalizing) {
            const stopped = await processing.getOwnedFile(fileId, job.jobId, settingId);
            if (stopped) {
                await finishStopped(stopped, job);
            }
            return { stopped: true };
        }

        await validateOutput(ctx.outputPath);
        const beforeFilters = await processing.getOwnedFile(fileId, job.jobId, settingId);
        if (!beforeFilters || beforeFilters.cancelled || beforeFilters.status === FILE_STATUS.stopped) {
            if (beforeFilters) {
                await finishStopped(beforeFilters, job);
            }
            return { stopped: true };
        }

        const rejectedBy = await runFilters(setting.filters || [], file.path, ctx.outputPath);
        // Overwrite success claims committing together with its replacing journal. Every other
        // terminal path claims it here so stop either wins before this point or is rejected late.
        const committing =
            ctx.isOverwrite && !rejectedBy
                ? true
                : await processing.transitionOwner(
                      fileId,
                      job.jobId,
                      { activePhase: "committing" },
                      { requireActive: true },
                  );
        if (!committing) {
            const stopped = await processing.getOwnedFile(fileId, job.jobId, settingId);
            if (stopped) {
                await finishStopped(stopped, job);
            }
            return { stopped: true };
        }

        if (rejectedBy) {
            await finishRejected(ctx, rejectedBy);
            return { rejected: true };
        }

        const outputSize = ctx.isOverwrite ? await finishOverwriteSuccess(ctx) : await finishAdjacentSuccess(ctx);
        if (outputSize == null) {
            return { stopped: true };
        }
        const reductionPct = file.size ? Math.round((1 - outputSize / file.size) * 100) : 0;
        logging.log(
            "transcode",
            `done ${file.path} ("${setting.name}"): ${reductionPct}% smaller` +
                (ctx.isOverwrite ? " (overwritten in place)" : ""),
        );
        return { completed: true };
    } catch (error) {
        logging.error("transcode", `finalize ${job.jobId}: ${error.message}`);
        await recoverFinalizationError(ctx, error);
        return { failed: true, error: error.message };
    }
}
