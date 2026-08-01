import crypto from "node:crypto";
import * as db from "../database/index.js";
import { DEFAULT_TRANSCODE_SETTINGS } from "../database/schemas/settings.js";
import * as logging from "./logging.js";
import { COLLECTION, SETTINGS_DOC_ID } from "shared/domain.js";

// Built-in presets are sourced from code, never persisted. They carry a "default-" id prefix, so we
// can recognise (and drop) any that linger in an older stored doc from before this rule existed.
const BUILTIN_ID_PREFIX = "default-";
const isBuiltin = (s) => s?.isDefault === true || (typeof s?.id === "string" && s.id.startsWith(BUILTIN_ID_PREFIX));
let mutationQueue = Promise.resolve();

function serializeMutation(operation) {
    const pending = mutationQueue.then(operation, operation);
    mutationQueue = pending.catch(() => {});
    return pending;
}

function revisionFor(settings) {
    const editable = {
        videoExtensions: settings.videoExtensions,
        autoScanIntervalMinutes: settings.autoScanIntervalMinutes,
        transcodeSettings: settings.transcodeSettings,
    };
    return crypto.createHash("sha256").update(JSON.stringify(editable)).digest("base64url");
}

// The transcode list everything reads: the built-in presets (from code, flagged `isDefault`) first,
// then the user's own settings (from the DB). Built-ins are merged on every read, so editing
// DEFAULT_TRANSCODE_SETTINGS in code takes effect with no database change. Any built-in still sitting
// in the stored doc (legacy) is filtered out here so it can't shadow the code copy.
function mergeTranscodeSettings(stored) {
    const builtins = DEFAULT_TRANSCODE_SETTINGS.map((s) => ({ ...s, isDefault: true }));
    const userSettings = (stored?.transcodeSettings || [])
        .filter((s) => !isBuiltin(s))
        .map((s) => ({ ...s, isDefault: false }));
    return [...builtins, ...userSettings];
}

export async function get() {
    const base = db.defaults(COLLECTION.settings);
    const stored = await db.get(COLLECTION.settings, SETTINGS_DOC_ID);
    const merged = { ...base, ...(stored || {}), transcodeSettings: mergeTranscodeSettings(stored) };
    // Path settings moved to server config (utilities/config.js); drop any that linger in an older stored
    // doc so they're never exposed through the API. (They're rewritten out on the next save.)
    delete merged.dataDir;
    delete merged.ffmpegPath;
    delete merged.ffprobePath;
    merged.revision = revisionFor(merged);
    return merged;
}

export function save(settings) {
    return serializeMutation(async () => {
        const current = await get();
        if (settings.revision !== current.revision) return { error: "settings_conflict", value: current };

        // Pause is authoritative and can only be changed by setProcessing(). A general replacement
        // always carries forward the latest server value, even when its client snapshot is stale.
        const userSettings = (settings.transcodeSettings || []).filter((s) => !isBuiltin(s));
        await db.add(COLLECTION.settings, SETTINGS_DOC_ID, {
            videoExtensions: settings.videoExtensions,
            autoScanIntervalMinutes: settings.autoScanIntervalMinutes,
            processingPaused: current.processingPaused,
            transcodeSettings: userSettings,
        });
        return { value: await get() };
    });
}

export function setProcessing(paused) {
    return serializeMutation(async () => {
        const current = await get();
        await db.add(COLLECTION.settings, SETTINGS_DOC_ID, {
            ...current,
            processingPaused: paused,
            transcodeSettings: (current.transcodeSettings || []).filter((s) => !isBuiltin(s)),
        });
        return get();
    });
}

export async function initialize() {
    const existing = await db.get(COLLECTION.settings, SETTINGS_DOC_ID);
    if (!existing) {
        await db.add(COLLECTION.settings, SETTINGS_DOC_ID, db.defaults(COLLECTION.settings));
        logging.log("settings", "wrote default settings (first run)");
    }
}
