// Actions controller — pipeline-level operations that aren't tied to a single document:
// the global processing pause/resume flag and triggering a directory scan.
import { eventService, settingsService, loggingService } from "../services/index.js";
import { JOB_TYPE } from "shared/domain.js";
import { getResult } from "shared/response.js";

export async function getProcessing() {
    const settings = await settingsService.get();

    return getResult(true, "processing_state", { paused: settings.processingPaused || false });
}

export async function setProcessing(paused) {
    const settings = await settingsService.setProcessing(paused);

    loggingService.log("api", `processing ${paused ? "paused" : "resumed"}`);

    return getResult(true, "processing_updated", { paused: settings.processingPaused });
}

export async function scan() {
    const jobId = await eventService.enqueue(JOB_TYPE.SCAN_DIRECTORY, {});

    return getResult(true, "scan_enqueued", { jobId });
}
