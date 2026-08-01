// Job schema — the single source of truth for the shape, defaults, and indexes of a
// queued job document. Exports plain functions (no compiled model); database.js compiles
// and caches the model via getModel().
//
// Node-loaded service code, so domain.js is imported relatively (see AGENTS.md import notes).
import mongoose from "mongoose";
import { JOB_STATUS } from "shared/domain.js";
import { baseOptions, Mixed } from "./base.js";

const Schema = mongoose.Schema;

export function getSchema() {
    const jobSchema = new Schema(
        {
            jobId: { type: String, required: true, unique: true, index: true },
            type: String,
            payload: { type: Mixed, default: {} },
            status: { type: String, default: JOB_STATUS.pending },
            createdAt: { type: Number, default: Date.now },
            startedAt: { type: Number, default: null },
            finishedAt: { type: Number, default: null },
            progress: { type: String, default: null },
            error: { type: String, default: null },
            // Persisted command preparation state. Finalization never reconstructs a task's
            // destination from the file's mutable aggregate state.
            preparedOutputPath: { type: String, default: null },
            finalOutputPath: { type: String, default: null },
            taskGenerationId: { type: String, default: null },
            outputMode: { type: String, default: null },
            lifecyclePhase: { type: String, default: null },
        },
        baseOptions,
    );
    // Queue polling filters by status and orders by creation time.
    jobSchema.index({ status: 1, createdAt: 1 });
    return jobSchema;
}

export function getName() {
    return "jobs";
}

export function getIdField() {
    return "jobId";
}
