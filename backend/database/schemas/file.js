// File schema — the single source of truth for the shape, defaults, and indexes of a
// scanned source file document and its transcode-attempt results. Exports plain functions
// (no compiled model); database.js compiles and caches the model via getModel().
//
// Node-loaded service code, so domain.js is imported relatively (see AGENTS.md import notes).
import mongoose from "mongoose";
import { FILE_STATUS } from "shared/domain.js";
import { baseOptions, Mixed } from "./base.js";

const Schema = mongoose.Schema;

// A single transcode attempt's outcome (file.transcodeResults[]). Fields vary by status
// (done / failed / rejected / replaced), so all but the identifiers are optional.
const transcodeResultSchema = new Schema(
    {
        settingId: String,
        settingName: String,
        inputPath: String,
        inputSize: Number,
        outputPath: { type: String, default: null },
        outputSize: { type: Number, default: 0 },
        outputMode: String,
        status: String,
        error: { type: String, default: null },
        rejectedBy: { type: String, default: null },
        completedAt: Number,
    },
    { _id: false },
);

export function getSchema() {
    return new Schema(
        {
            fileId: { type: String, required: true, unique: true, index: true },
            path: String,
            size: { type: Number, default: 0 },
            status: { type: String, default: FILE_STATUS.pending },
            addedAt: { type: Number, default: Date.now },
            processedAt: { type: Number, default: null },
            ffprobeData: { type: Mixed, default: null },
            errorMessage: { type: String, default: null },
            transcodeResults: { type: [transcodeResultSchema], default: [] },
            replaced: { type: Boolean, default: false },
            cancelled: { type: Boolean, default: false },
            // Durable ownership for the one transcode allowed to touch this source at a time.
            // jobId is also the task generation: stale runner results cannot match a newer owner.
            activeJobId: { type: String, default: null, index: true },
            activeSettingId: { type: String, default: null },
            activeProbeJobId: { type: String, default: null },
            activePhase: { type: String, default: null },
            // Persisted atomically with a failure commit claim so restart recovery cannot mistake
            // a failed attempt for ordinary interrupted/retryable work.
            failureMessage: { type: String, default: null },
            // currentOutputPath is always a generation-owned scratch path. Adjacent mode
            // separately reserves its stable user-visible destination.
            currentOutputPath: { type: String, default: null },
            reservedOutputPath: { type: String, default: null },
            processingStartedAt: { type: Number, default: null },
            // Overwrite replacement is journaled until both filesystem and database state are
            // durable. Mixed keeps the phase-specific metadata together as one recovery record.
            overwriteJournal: { type: Mixed, default: null },
            adjacentJournal: { type: Mixed, default: null },
            // Scratch generations retired after reassignment remain exclusion tombstones. An old
            // partitioned executor may recreate them after best-effort cleanup.
            retiredOutputPaths: { type: [String], default: [] },
            replacedAt: { type: String, default: null },
        },
        baseOptions,
    );
}

export function getName() {
    return "files";
}

export function getIdField() {
    return "fileId";
}
