import { execFile } from "child_process";
import path from "path";
import * as db from "../database/index.js";
import * as settings from "./settings.js";
import * as event from "./event.js";
import * as jobService from "./job.js";
import * as logging from "./logging.js";
import * as processing from "./processing.js";
import * as serverConfig from "../utilities/config.js";
import { matchesPattern } from "./safe-pattern.js";
import { FFPROBE_TIMEOUT_MS } from "../utilities/constants.js";
import { COLLECTION, FILE_STATUS, JOB_TYPE } from "shared/domain.js";

export const FFPROBE_TIMEOUT_DIAGNOSTIC = "ffprobe_timeout";

// Keep the process primitive injectable so timeout behavior and all ordinary execFile failures are
// deterministic in tests. The timeout applies through stdout collection and SIGKILL guarantees a
// probe cannot ignore the deadline.
export function probeMedia(
    filePath,
    { executable = serverConfig.ffprobePath, timeoutMs = FFPROBE_TIMEOUT_MS, execFileImpl = execFile } = {},
) {
    const args = ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", filePath];
    return new Promise((resolve, reject) => {
        execFileImpl(executable, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
            if (error) {
                if (error.killed && error.signal === "SIGKILL") {
                    const timeoutError = new Error(FFPROBE_TIMEOUT_DIAGNOSTIC);
                    timeoutError.code = "FFPROBE_TIMEOUT";
                    timeoutError.cause = error;
                    reject(timeoutError);
                    return;
                }
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

export async function getMatchingSettings(transcodeSettings, filePath) {
    const fileExtension = path.extname(filePath).slice(1).toLowerCase();
    const matching = [];

    // Evaluate in source order so equal-priority profiles retain their createdAt ordering after
    // the stable sort, while each user regex runs outside the monitor event loop.
    for (const setting of transcodeSettings) {
        if (setting.enabled === false) continue;
        if (setting.fileExtensions?.length > 0 && !setting.fileExtensions.includes(fileExtension)) continue;
        if (await matchesPattern(filePath, setting.matchPattern)) matching.push(setting);
    }

    return matching.sort((a, b) => {
        const priorityA = a.priority ?? 999;
        const priorityB = b.priority ?? 999;
        return priorityA !== priorityB ? priorityA - priorityB : (a.createdAt || 0) - (b.createdAt || 0);
    });
}

export async function handleProbeFile(job) {
    const { fileId } = job.payload;
    let claimed = false;
    let claimedFile = null;
    await processing.updateFileLifecycle(fileId, (file) => {
        if (
            !file ||
            file.status !== FILE_STATUS.pending ||
            (file.activeProbeJobId && file.activeProbeJobId !== job.jobId)
        ) {
            return file;
        }
        claimed = true;
        claimedFile = file;
        return { ...file, activeProbeJobId: job.jobId };
    });
    if (!claimed) {
        return;
    }

    logging.log("probe", `probing ${claimedFile.path}`);
    const config = await settings.get();

    try {
        const { stdout } = await probeMedia(claimedFile.path);
        const ffprobeData = JSON.parse(stdout);

        // Stop/requeue can supersede a slow probe. Only this probe generation may publish output.
        let stillOwner = false;
        await processing.updateFileLifecycle(fileId, (file) => {
            if (file?.activeProbeJobId !== job.jobId || file.status !== FILE_STATUS.pending) {
                return file;
            }
            stillOwner = true;
            return { ...file, ffprobeData, status: FILE_STATUS.queued };
        });
        if (!stillOwner) {
            return;
        }

        const matchingSettings = await getMatchingSettings(config.transcodeSettings || [], claimedFile.path);
        if (matchingSettings.length === 0) {
            await processing.updateFileLifecycle(fileId, (file) => {
                if (file?.activeProbeJobId !== job.jobId) {
                    return file;
                }
                if (file.status !== FILE_STATUS.queued) {
                    return { ...file, activeProbeJobId: null };
                }
                return { ...file, status: FILE_STATUS.ignored, activeProbeJobId: null };
            });
            logging.log("probe", `${claimedFile.path} → ignored (no matching transcode settings)`);
            return;
        }

        for (const setting of matchingSettings) {
            const current = await db.get(COLLECTION.files, fileId);
            if (current?.activeProbeJobId !== job.jobId || current.status !== FILE_STATUS.queued) {
                break;
            }
            await event.enqueue(JOB_TYPE.TRANSCODE_FILE, {
                fileId,
                settingId: setting.id,
                probeJobId: job.jobId,
            });
        }
        let published = false;
        await processing.updateFileLifecycle(fileId, (file) => {
            if (file?.activeProbeJobId !== job.jobId) {
                return file;
            }
            published = file.status === FILE_STATUS.queued;
            return { ...file, activeProbeJobId: null };
        });
        if (!published) {
            // A stop may have landed between the final owner check and enqueue. Fence any job
            // created in that tiny window before returning from the superseded probe.
            await jobService.failProbeGeneration(fileId, job.jobId, "Probe generation superseded");
            return;
        }
        logging.log("probe", `${claimedFile.path} → queued ${matchingSettings.length} transcode job(s)`);
    } catch (error) {
        let failedOwner = false;
        await processing.updateFileLifecycle(fileId, (file) => {
            if (file?.activeProbeJobId !== job.jobId) {
                return file;
            }
            if (file.status !== FILE_STATUS.pending) {
                return { ...file, activeProbeJobId: null };
            }
            failedOwner = true;
            return {
                ...file,
                status: FILE_STATUS.failed,
                errorMessage: `Probe failed: ${error.code === "FFPROBE_TIMEOUT" ? FFPROBE_TIMEOUT_DIAGNOSTIC : error.message}`,
                activeProbeJobId: null,
            };
        });
        if (failedOwner) {
            logging.error("probe", `failed for ${claimedFile.path}: ${error.message}`);
        }
    }
}
