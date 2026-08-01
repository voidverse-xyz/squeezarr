import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import * as db from "../database/index.js";
import * as settings from "./settings.js";
import * as event from "./event.js";
import * as job from "./job.js";
import { getMatchingSettings } from "./probe.js";
import * as logging from "./logging.js";
import * as serverConfig from "../utilities/config.js";
import { collectKnownOutputPaths, findStrayOutputDocs } from "../utilities/scanpath.js";
import { COLLECTION, FILE_STATUS, JOB_TYPE } from "shared/domain.js";

// A transcode is uniquely identified by its (fileId, settingId) pair; this composite key lets us
// dedupe a file's already-queued/running transcodes against the ones we're about to (re)enqueue.
const transcodeKey = (fileId, settingId) => `${fileId}:${settingId}`;

// Re-drive files stuck in "queued". A file lands here once probed, but its transcode
// setting can later be disabled or deleted — that setting's job is then skipped, leaving
// the file orphaned with no path to "processing". For each queued file we (re)enqueue
// transcodes for the currently-enabled matching settings that have neither a recorded
// result nor an in-flight job, and mark it "ignored" if nothing matches anymore.
async function reconcileQueuedFiles(transcodeSettings) {
    const queuedFiles = (await db.getAll(COLLECTION.files)).filter((file) => file.status === FILE_STATUS.queued);
    if (queuedFiles.length === 0) {
        return;
    }

    const pendingAndRunning = [...(await job.listPending()), ...(await job.listRunning())];
    const inFlight = new Set(
        pendingAndRunning
            .filter((j) => j.type === JOB_TYPE.TRANSCODE_FILE)
            .map((j) => transcodeKey(j.payload?.fileId, j.payload?.settingId)),
    );

    let requeued = 0;
    for (const file of queuedFiles) {
        const matching = await getMatchingSettings(transcodeSettings, file.path);

        if (matching.length === 0) {
            await db.patch(COLLECTION.files, file.fileId, { status: FILE_STATUS.ignored });
            continue;
        }

        const attempted = new Set((file.transcodeResults || []).map((r) => r.settingId));
        let enqueued = 0;
        for (const setting of matching) {
            if (attempted.has(setting.id) || inFlight.has(transcodeKey(file.fileId, setting.id))) {
                continue;
            }
            await event.enqueue(JOB_TYPE.TRANSCODE_FILE, { fileId: file.fileId, settingId: setting.id });
            enqueued++;
        }
        if (enqueued > 0) {
            requeued++;
        }
    }

    if (requeued > 0) {
        logging.log("scan", `re-queued ${requeued} stuck file(s) for transcoding`);
    }
}

export async function getDiscoveredFileSize(filePath, stat = fs.stat) {
    try {
        return (await stat(filePath)).size;
    } catch (error) {
        if (error.code !== "ENOENT") {
            logging.error("scan", `could not stat ${filePath}: ${error.message}`);
        }
        return null;
    }
}

async function walkDirectory(dir, extensions) {
    const results = [];

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...(await walkDirectory(fullPath, extensions)));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).slice(1).toLowerCase();
                if (extensions.includes(ext)) {
                    results.push(fullPath);
                }
            }
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            logging.error("scan", `error in ${dir}: ${error.message}`);
        }
    }

    return results;
}

export async function handleScanDirectory() {
    const config = await settings.get();
    logging.log("scan", `scanning ${serverConfig.dataDir}`);
    const discoveredFiles = await walkDirectory(serverConfig.dataDir, config.videoExtensions);

    // Exclude paths that are known transcode outputs — they should never be queued as
    // sources. This must cover outputs from *finished* transcodes (transcodeResults[]) as
    // well as outputs from a transcode that is still running or was interrupted mid-write
    // (currentOutputPath, set on the source file's doc before ffmpeg is spawned and cleared
    // on every exit path — see ffmpeg.js). Without the latter, a scan that lands while a
    // transcode is in flight, or before a crashed one is recovered, can see the partial
    // output on disk and create a `files` doc for it.
    const existingFiles = await db.getAll(COLLECTION.files);
    const knownOutputPaths = collectKnownOutputPaths(existingFiles);

    // A stray `files` doc can already exist for one of these paths — e.g. created by a scan
    // that ran in that same window before this exclusion applied, or before the in-flight
    // output was recovered. Such a doc has no path back out (probe/transcode keep acting on
    // it, producing chained outputs like *.hevc.hevc.mkv), so once we know a path is an
    // output, any existing doc for it is removed rather than left to be reprocessed forever.
    for (const file of findStrayOutputDocs(existingFiles, knownOutputPaths)) {
        await db.remove(COLLECTION.files, file.fileId);
        logging.log("scan", `removed stray file doc for known output ${file.path}`);
    }

    let newFileCount = 0;
    for (const filePath of discoveredFiles) {
        if (knownOutputPaths.has(filePath)) {
            continue;
        }

        const fileId = crypto.createHash("sha1").update(filePath).digest("hex");
        if (await db.exists(COLLECTION.files, fileId)) {
            continue;
        }

        const size = await getDiscoveredFileSize(filePath);
        if (size === null) {
            // The file vanished between readdir and stat, or cannot be read. Do not create a
            // size-zero phantom document that would prevent a later scan from rediscovering it.
            continue;
        }

        // status, timestamps, and the rest of the file shape come from the schema defaults.
        await db.add(COLLECTION.files, fileId, { path: filePath, size });
        newFileCount++;
    }

    logging.log("scan", `complete: ${discoveredFiles.length} video file(s) found, ${newFileCount} new`);

    const allFiles = await db.getAll(COLLECTION.files);
    const pendingFiles = allFiles
        .filter((file) => file.status === FILE_STATUS.pending)
        .sort((a, b) => (a.size || 0) - (b.size || 0));

    for (const file of pendingFiles) {
        await event.enqueue(JOB_TYPE.PROBE_FILE, { fileId: file.fileId });
    }

    if (pendingFiles.length > 0) {
        logging.log("scan", `queued ${pendingFiles.length} file(s) for probing`);
    }

    await reconcileQueuedFiles(config.transcodeSettings || []);

    // Housekeeping piggybacked on the scan cadence: drop finished jobs beyond the listing cap so
    // the jobs collection can't grow without bound.
    const pruned = await job.pruneFinished();
    if (pruned > 0) {
        logging.log("scan", `pruned ${pruned} old finished job(s)`);
    }
}
