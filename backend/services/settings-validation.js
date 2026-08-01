// Validation for the settings PUT payload — the security-critical surface. Returns
// { error: "invalid_<field>" } | { value }, so the controller hands the error straight back through
// the getResult envelope without throwing. Most fields are coerced; the ones that feed ffmpeg
// execution or the output path are validated and rejected.
//
// The transcode `flags` are the only thing the user contributes to the command — the server owns the
// binary, the input, and the output (ffmpeg.js builds `ffmpeg -y -i <input> <flags> <output>`). Only
// flag options on utilities/config.js's allowlist are accepted, and no token may contain a path/protocol,
// so ffmpeg can't be steered to read or write files we didn't choose.
import { sanitize } from "../utilities/sanitize.js";
import { ALLOWED_FLAGS } from "../utilities/config.js";
import { OUTPUT_MODE, FILTER_ID } from "shared/domain.js";

const OUTPUT_MODES = Object.values(OUTPUT_MODE);
const FILTERS = Object.values(FILTER_ID);

const isPlainObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function validateSettings(raw) {
    if (!isPlainObject(raw)) return { error: "invalid_settings" };
    if (
        !hasOwn(raw, "videoExtensions") ||
        !Array.isArray(raw.videoExtensions) ||
        raw.videoExtensions.some((value) => typeof value !== "string")
    ) {
        return { error: "invalid_videoExtensions" };
    }
    if (!hasOwn(raw, "transcodeSettings") || !Array.isArray(raw.transcodeSettings)) {
        return { error: "invalid_transcodeSettings" };
    }
    if (
        !hasOwn(raw, "autoScanIntervalMinutes") ||
        typeof raw.autoScanIntervalMinutes !== "number" ||
        !Number.isFinite(raw.autoScanIntervalMinutes)
    ) {
        return { error: "invalid_autoScanIntervalMinutes" };
    }
    if (!hasOwn(raw, "revision") || typeof raw.revision !== "string" || !raw.revision) {
        return { error: "invalid_revision" };
    }

    const transcodeSettings = [];
    for (const rawSetting of raw.transcodeSettings) {
        const { error, value } = validateTranscodeSetting(rawSetting);
        if (error) return { error };
        transcodeSettings.push(value);
    }

    return {
        value: {
            videoExtensions: sanitize.list(raw.videoExtensions),
            autoScanIntervalMinutes: sanitize.int(raw.autoScanIntervalMinutes, { min: 0, max: 1440, fallback: 60 }),
            transcodeSettings,
            revision: raw.revision,
        },
    };
}

// An output-path component (prefix/suffix/extension): must not let a write escape the output dir.
const isSafePathPart = (s) => !s.includes("/") && !s.includes("..") && !s.includes("\0");

function validateTranscodeSetting(raw) {
    if (!isPlainObject(raw)) return { error: "invalid_setting" };
    if (!Array.isArray(raw.fileExtensions) || raw.fileExtensions.some((value) => typeof value !== "string")) {
        return { error: "invalid_fileExtensions" };
    }
    if (!Array.isArray(raw.filters) || raw.filters.some((value) => typeof value !== "string")) {
        return { error: "invalid_filters" };
    }

    const id = sanitize.text(raw.id);
    const name = sanitize.text(raw.name);
    if (!id) return { error: "invalid_settingId" };
    if (!name) return { error: "invalid_name" };

    const flags = validateFlags(raw.flags);
    if (flags === null) return { error: "invalid_flags" };

    const matchPattern = sanitize.text(raw.matchPattern);
    if (matchPattern) {
        if (matchPattern.length > 500) return { error: "invalid_matchPattern" };
        try {
            new RegExp(matchPattern);
        } catch {
            return { error: "invalid_matchPattern" };
        }
    }

    const prefix = sanitize.text(raw.prefix);
    const suffix = sanitize.text(raw.suffix);
    const outputExtension = sanitize.text(raw.outputExtension);
    if (!isSafePathPart(prefix)) return { error: "invalid_prefix" };
    if (!isSafePathPart(suffix)) return { error: "invalid_suffix" };
    if (!isSafePathPart(outputExtension)) return { error: "invalid_outputExtension" };

    return {
        value: {
            id,
            name,
            enabled: sanitize.bool(raw.enabled),
            priority: sanitize.int(raw.priority, { min: 0, max: 999, fallback: 10 }),
            fileExtensions: sanitize.list(raw.fileExtensions),
            matchPattern,
            flags,
            outputMode: sanitize.enum(raw.outputMode, OUTPUT_MODES) ?? OUTPUT_MODE.adjacent,
            prefix,
            suffix,
            outputExtension,
            filters: (Array.isArray(raw.filters) ? raw.filters : []).filter((f) => FILTERS.includes(f)),
            deleteOnReject: sanitize.bool(raw.deleteOnReject),
            createdAt: raw.createdAt,
        },
    };
}

// The ffmpeg flags between input and output. Each flag option must be on the allowlist (stream
// specifiers like `-c:v` match on the base `-c`), and no token may contain a path or protocol.
// Returns the cleaned flags string, or null if anything is disallowed.
function validateFlags(raw) {
    const flags = sanitize.text(raw);
    if (flags.length > 1000) return null;
    const tokens = flags.split(/\s+/).filter(Boolean);
    if (tokens.length > 60) return null;
    for (const token of tokens) {
        if (token.includes("/") || token.includes("\0")) return null; // paths, protocols, NUL tricks
        if (token.startsWith("-") && !ALLOWED_FLAGS.has(token.split(":")[0])) return null;
    }
    return flags;
}
