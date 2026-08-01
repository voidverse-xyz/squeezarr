// Recording a transcode's outcome on its file doc. Every finalize handler ends by writing one
// transcodeResults entry; this module owns both the shared shape of that entry and the upsert that
// persists it, so the handlers only supply the fields that differ between outcomes.
import * as db from "../../database/index.js";
import { COLLECTION, FILE_STATUS, RESULT_STATUS } from "shared/domain.js";

// Merge the fields every result shares (which setting ran, the input it ran against, the output
// mode, and when it finished) with the outcome-specific `overrides` (status, output path/size,
// error or rejection reason).
export function buildResult({ file, setting, settingId }, overrides) {
    return {
        settingId,
        settingName: setting.name,
        inputPath: file.path,
        inputSize: file.size,
        outputMode: setting.outputMode,
        completedAt: Date.now(),
        ...overrides,
    };
}

// Upsert a transcode result by settingId — replace the existing entry for this setting or append a
// new one, so a re-run overwrites its previous result rather than stacking duplicates.
export function mergeTranscodeResult(file, result) {
    const results = file?.transcodeResults || [];
    const existingIndex = results.findIndex((item) => item.settingId === result.settingId);
    const updatedResults =
        existingIndex >= 0
            ? results.map((item, index) => (index === existingIndex ? result : item))
            : [...results, result];
    return { ...file, transcodeResults: updatedResults };
}

export async function upsertTranscodeResult(fileId, result) {
    // The facade supplies the latest serialized file snapshot, so this result merge cannot replace
    // ownership or cancellation fields published by an earlier lifecycle mutation.
    await db.update(COLLECTION.files, fileId, (file) => (file ? mergeTranscodeResult(file, result) : file));
}

// Aggregate status is order-independent: outstanding profiles keep the file queued, then any
// usable output wins over failures/rejections. Only a file with no usable output is failed or
// rejected as a whole.
export function deriveAggregateStatus(file, activeJobs = []) {
    if (file.status === FILE_STATUS.stopped) {
        return FILE_STATUS.stopped;
    }
    if (file.activeJobId) {
        return FILE_STATUS.processing;
    }
    if (activeJobs.length > 0) {
        return FILE_STATUS.queued;
    }

    const results = file.transcodeResults || [];
    if (file.replaced || results.some((result) => result.status === RESULT_STATUS.replaced)) {
        return FILE_STATUS.replaced;
    }
    if (results.some((result) => result.status === RESULT_STATUS.done && result.outputPath)) {
        return FILE_STATUS.transcoded;
    }
    if (results.length > 0 && results.every((result) => result.status === RESULT_STATUS.rejected)) {
        return FILE_STATUS.rejected;
    }
    if (results.some((result) => result.status === RESULT_STATUS.failed)) {
        return FILE_STATUS.failed;
    }
    if (results.some((result) => result.status === RESULT_STATUS.rejected)) {
        return FILE_STATUS.rejected;
    }
    return FILE_STATUS.queued;
}
