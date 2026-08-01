// Monitor-side transcode preparation: reserve a collision-safe task-owned destination, claim the
// file for this job generation, persist the prepared path on both documents, then build ffmpeg.
import { lstat } from "fs/promises";
import crypto from "crypto";
import path from "path";
import * as db from "../../database/index.js";
import * as settings from "../settings.js";
import * as logging from "../logging.js";
import * as processing from "../processing.js";
import * as serverConfig from "../../utilities/config.js";
import { resolveSetting } from "./shared.js";
import { buildResult, mergeTranscodeResult } from "./results.js";
import { COLLECTION, FILE_STATUS, OUTPUT_MODE, RESULT_STATUS } from "shared/domain.js";

const TERMINAL_STATUSES = [FILE_STATUS.replaced, FILE_STATUS.stopped];

function summarizeMedia(ffprobeData) {
    const video = ffprobeData?.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(ffprobeData?.format?.duration);
    return {
        codec: video?.codec_name ?? null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        duration: Number.isFinite(duration) ? duration : null,
    };
}

function resolveOutputExtension(setting, inputExt) {
    if (!setting.outputExtension) {
        return inputExt;
    }
    return setting.outputExtension.startsWith(".") ? setting.outputExtension : `.${setting.outputExtension}`;
}

export function buildFinalOutputPath(file, setting) {
    if (setting.outputMode === OUTPUT_MODE.overwrite) {
        return file.path;
    }
    const inputExt = path.extname(file.path);
    const baseName = path.basename(file.path, inputExt);
    const outputExt = resolveOutputExtension(setting, inputExt);
    return path.join(path.dirname(file.path), `${setting.prefix || ""}${baseName}${setting.suffix || ""}${outputExt}`);
}

// Every runner writes a hidden preparation-generation scratch file. A reassigned job gets a new
// generation token even though its durable jobId remains the lifecycle owner, so an unfenced old
// executor cannot write into the new attempt or the stable adjacent destination.
export function buildOutputPath(file, setting, jobId, taskGenerationId = jobId) {
    const inputExt = path.extname(file.path);
    const baseName = path.basename(file.path, inputExt);
    const outputExt = resolveOutputExtension(setting, inputExt);
    return path.join(path.dirname(file.path), `.${baseName}.transcodetmp.${jobId}.${taskGenerationId}${outputExt}`);
}

export function buildBackupPath(file, jobId) {
    const inputExt = path.extname(file.path);
    const baseName = path.basename(file.path, inputExt);
    return path.join(path.dirname(file.path), `.${baseName}.transcodebak.${jobId}${inputExt}`);
}

function pathOwner(files, outputPath) {
    for (const candidate of files) {
        if (candidate.path === outputPath) {
            return { kind: "source", fileId: candidate.fileId };
        }
        if (candidate.currentOutputPath === outputPath) {
            return { kind: "active scratch output", fileId: candidate.fileId, jobId: candidate.activeJobId };
        }
        if (candidate.reservedOutputPath === outputPath) {
            return { kind: "reserved output", fileId: candidate.fileId, jobId: candidate.activeJobId };
        }
        const journalPath = [
            ...(candidate.retiredOutputPaths || []),
            candidate.adjacentJournal?.scratchPath,
            candidate.adjacentJournal?.finalPath,
            candidate.overwriteJournal?.tempPath,
            candidate.overwriteJournal?.backupPath,
        ].find((ownedPath) => ownedPath === outputPath);
        if (journalPath) {
            return { kind: "journal-owned output", fileId: candidate.fileId, jobId: candidate.activeJobId };
        }
        const result = (candidate.transcodeResults || []).find((item) => item.outputPath === outputPath);
        if (result) {
            return { kind: "completed output", fileId: candidate.fileId, settingId: result.settingId };
        }
    }
    return null;
}

async function exists(filePath) {
    try {
        await lstat(filePath);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

export async function inspectOutputCollision({ files, file, setting, job, outputPath }) {
    const owner = pathOwner(files, outputPath);
    const ownedRegeneration =
        job.payload?.regenerateOwnedOutput === true &&
        owner?.kind === "completed output" &&
        owner.fileId === file.fileId &&
        owner.settingId === setting.id;

    if (owner && !ownedRegeneration) {
        return `${outputPath} is already owned as ${owner.kind} by file ${owner.fileId}`;
    }
    if ((await exists(outputPath)) && !ownedRegeneration) {
        return `${outputPath} already exists on disk without an authorized regeneration owner`;
    }
    return null;
}

async function recordPreparationFailure(file, setting, settingId, message) {
    const result = buildResult(
        { file, setting, settingId },
        { outputPath: null, outputSize: 0, status: RESULT_STATUS.failed, error: message },
    );
    await processing.updateFileLifecycle(file.fileId, (current) => {
        if (!current || current.status === FILE_STATUS.stopped || current.cancelled) {
            return current;
        }
        return {
            ...mergeTranscodeResult(current, result),
            status: FILE_STATUS.failed,
            errorMessage: message,
        };
    });
}

export async function prepareTranscode(job) {
    const { fileId, settingId } = job.payload;
    let file = await processing.inspectFileLifecycle(fileId, (current) => current);
    if (!file || TERMINAL_STATUSES.includes(file.status)) {
        return null;
    }

    // Disconnect recovery releases the active owner before this same queue job is prepared again.
    // Retire the old adjacent scratch generation as a permanent scanner-exclusion tombstone: a
    // partitioned executor can recreate it even after best-effort unlink. The new attempt always
    // receives a fresh scratch generation below.
    if (!file.activeJobId && file.adjacentJournal?.jobId === job.jobId) {
        file = await processing.updateFileLifecycle(fileId, (current) =>
            current?.adjacentJournal?.jobId === job.jobId
                ? {
                      ...current,
                      currentOutputPath: null,
                      reservedOutputPath: null,
                      adjacentJournal: null,
                      retiredOutputPaths: [
                          ...new Set([...(current.retiredOutputPaths || []), current.adjacentJournal.scratchPath]),
                      ],
                  }
                : current,
        );
    }
    if (!file) {
        return null;
    }
    if (file.activeJobId && file.activeJobId !== job.jobId) {
        return { deferred: true, fileId };
    }

    const config = await settings.get();
    const setting = resolveSetting(config, settingId);
    if (!setting) {
        logging.warn("transcode", `setting "${settingId}" not found — skipping`);
        return null;
    }
    if (setting.enabled === false) {
        logging.log("transcode", `setting "${settingId}" is disabled — skipping`);
        return null;
    }

    const taskGenerationId = crypto.randomUUID();
    const outputPath = buildOutputPath(file, setting, job.jobId, taskGenerationId);
    const finalOutputPath = buildFinalOutputPath(file, setting);
    if (finalOutputPath === file.path && setting.outputMode !== OUTPUT_MODE.overwrite) {
        const message = `Output path resolves to the input path — give "${setting.name}" a prefix, suffix, or different output extension`;
        await recordPreparationFailure(file, setting, settingId, message);
        throw new Error(message);
    }

    const allFiles = await db.getAll(COLLECTION.files);
    const destinationCollision =
        setting.outputMode === OUTPUT_MODE.adjacent
            ? await inspectOutputCollision({ files: allFiles, file, setting, job, outputPath: finalOutputPath })
            : null;
    const scratchCollision = await inspectOutputCollision({ files: allFiles, file, setting, job, outputPath });
    const collision = destinationCollision || scratchCollision;
    if (collision) {
        const message = `Output collision: ${collision}`;
        await recordPreparationFailure(file, setting, settingId, message);
        throw new Error(message);
    }

    const now = Date.now();
    const isOverwrite = setting.outputMode === OUTPUT_MODE.overwrite;
    const journal = isOverwrite
        ? {
              jobId: job.jobId,
              settingId,
              settingName: setting.name,
              inputSize: file.size,
              sourcePath: file.path,
              tempPath: outputPath,
              backupPath: buildBackupPath(file, `${job.jobId}.${taskGenerationId}`),
              outputMode: setting.outputMode,
              phase: "prepared",
          }
        : null;
    const adjacentJournal = !isOverwrite
        ? {
              jobId: job.jobId,
              settingId,
              settingName: setting.name,
              inputSize: file.size,
              inputPath: file.path,
              scratchPath: outputPath,
              finalPath: finalOutputPath,
              outputMode: setting.outputMode,
              phase: "prepared",
          }
        : null;

    let claimed = false;
    await processing.updateFileLifecycle(fileId, (current) => {
        if (!current || current.activeJobId || TERMINAL_STATUSES.includes(current.status)) {
            return current;
        }
        claimed = true;
        return {
            ...current,
            status: FILE_STATUS.processing,
            errorMessage: null,
            cancelled: false,
            activeJobId: job.jobId,
            activeSettingId: settingId,
            activePhase: "processing",
            failureMessage: null,
            processingStartedAt: now,
            currentOutputPath: outputPath,
            reservedOutputPath: isOverwrite ? null : finalOutputPath,
            overwriteJournal: journal,
            adjacentJournal,
        };
    });
    if (!claimed) {
        return { deferred: true, fileId };
    }

    try {
        await db.patch(COLLECTION.jobs, job.jobId, {
            preparedOutputPath: outputPath,
            finalOutputPath,
            taskGenerationId,
            outputMode: setting.outputMode,
            lifecyclePhase: "prepared",
        });
    } catch (error) {
        await processing.updateFileLifecycle(fileId, (current) =>
            current?.activeJobId === job.jobId
                ? {
                      ...current,
                      status:
                          current.status === FILE_STATUS.stopped || current.cancelled
                              ? FILE_STATUS.stopped
                              : FILE_STATUS.queued,
                      cancelled: false,
                      activeJobId: null,
                      activeSettingId: null,
                      activePhase: null,
                      failureMessage: null,
                      currentOutputPath: null,
                      reservedOutputPath: null,
                      processingStartedAt: null,
                      overwriteJournal: null,
                      adjacentJournal: null,
                  }
                : current,
        );
        throw error;
    }

    logging.log("transcode", `start ${file.path} → "${setting.name}"`);
    const executable = serverConfig.ffmpegPath;
    const flags = (setting.flags || "").trim().split(/\s+/).filter(Boolean);
    // New reservations use -n. Only an explicit, same-result regeneration may overwrite.
    const overwriteFlag = job.payload?.regenerateOwnedOutput === true ? "-y" : "-n";
    const args = [overwriteFlag, "-i", file.path, ...flags, outputPath];
    const currentFile = {
        name: path.basename(file.path),
        path: file.path,
        size: file.size,
        settingName: setting.name,
        outputMode: setting.outputMode,
        media: summarizeMedia(file.ffprobeData),
    };

    return {
        fileId,
        settingId,
        outputPath,
        finalOutputPath,
        taskGenerationId,
        inputPath: file.path,
        executable,
        args,
        currentFile,
    };
}
