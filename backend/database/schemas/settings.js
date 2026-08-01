// Settings schema — the single source of truth for the shape, defaults, and built-in
// transcode presets of the singleton settings document. Exports plain functions (no
// compiled model); database.js compiles and caches the model via getModel().
//
// Node-loaded service code, so domain.js is imported relatively (see AGENTS.md import notes).
import mongoose from "mongoose";
import { OUTPUT_MODE, FILTER_ID, SETTINGS_DOC_ID } from "shared/domain.js";
import { baseOptions } from "./base.js";

const Schema = mongoose.Schema;

const transcodeSettingSchema = new Schema(
    {
        id: String,
        name: String,
        enabled: { type: Boolean, default: true },
        priority: { type: Number, default: 10 },
        fileExtensions: { type: [String], default: [] },
        matchPattern: { type: String, default: "" },
        // The ffmpeg options between input and output only — the server builds the full command as
        // `ffmpeg -y -i <input> <flags> <output>` (binary/input/output are never user-supplied). Only
        // flags on utilities/config.js's allowlist are accepted (see services/settings-validation.js).
        flags: { type: String, default: "" },
        outputMode: { type: String, default: OUTPUT_MODE.adjacent },
        prefix: { type: String, default: "" },
        suffix: { type: String, default: "" },
        outputExtension: { type: String, default: "" },
        filters: { type: [String], default: [] },
        deleteOnReject: { type: Boolean, default: false },
        createdAt: { type: Number, default: 0 },
    },
    { _id: false },
);

// Built-in transcode presets — the source of truth lives here in code, NOT the database.
// settingsService merges these into every read (flagged `isDefault`) and strips them before any
// write, so editing this list takes effect immediately with no DB migration. The stored doc only
// ever holds the user's own settings; `transcodeSettings` therefore defaults to [] in the schema.
export const DEFAULT_TRANSCODE_SETTINGS = [
    {
        id: "default-hevc",
        name: "H.265 + AAC",
        enabled: true,
        priority: 10,
        fileExtensions: [],
        matchPattern: "",
        // crf 26 + preset slow: a small quality bump over the old crf 28, while `slow` finds better
        // compression at the same crf so the file stays small (slower presets shrink files for free).
        flags: "-map 0 -c:v libx265 -crf 26 -preset slow -c:a aac -b:a 192k -c:s copy",
        outputMode: OUTPUT_MODE.adjacent,
        prefix: "",
        suffix: ".hevc",
        outputExtension: "mkv",
        filters: [FILTER_ID.acceptMinimalSize],
        deleteOnReject: false,
        createdAt: 0,
    },
    {
        id: "default-av1",
        name: "AV1 + Opus",
        enabled: false,
        priority: 20,
        fileExtensions: [],
        matchPattern: "",
        flags: "-map 0 -c:v libsvtav1 -crf 30 -preset 6 -c:a libopus -c:s copy",
        outputMode: OUTPUT_MODE.adjacent,
        prefix: "",
        suffix: ".av1",
        outputExtension: "mkv",
        filters: [FILTER_ID.acceptMinimalSize],
        deleteOnReject: false,
        createdAt: 0,
    },
    {
        id: "default-hevc-lossless",
        name: "H.265 (lossless)",
        enabled: false,
        priority: 30,
        fileExtensions: [],
        matchPattern: "",
        // Mathematically lossless video + lossless (FLAC) audio — quality is preserved exactly, but
        // the output is usually LARGER than an already-compressed source. So no acceptMinimalSize
        // filter here (it would reject every output); the lossless result is always kept.
        flags: "-map 0 -c:v libx265 -x265-params lossless=1 -preset medium -c:a flac -c:s copy",
        outputMode: OUTPUT_MODE.adjacent,
        prefix: "",
        suffix: ".lossless",
        outputExtension: "mkv",
        filters: [],
        deleteOnReject: false,
        createdAt: 0,
    },
];

export function getSchema() {
    return new Schema(
        {
            settingsId: { type: String, default: SETTINGS_DOC_ID, unique: true, index: true },
            // dataDir / ffmpegPath / ffprobePath are server config (env), not stored here — see utilities/config.js.
            videoExtensions: {
                type: [String],
                default: ["mkv", "mp4", "avi", "mov", "ts", "m2ts", "wmv", "flv", "webm"],
            },
            autoScanIntervalMinutes: { type: Number, default: 60 },
            processingPaused: { type: Boolean, default: false },
            transcodeSettings: {
                type: [transcodeSettingSchema],
                default: [], // only user settings are stored; built-ins are merged in from code at read time
            },
        },
        baseOptions,
    );
}

export function getName() {
    return "settings";
}

export function getIdField() {
    return "settingsId";
}
