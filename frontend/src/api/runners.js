"use client";

import * as client from "./client.js";

// The backend resource is "runners" (the runner pool); the UI presents them as "Workers".
export function list(options) {
    return client.get("runners", options);
}

// Pause/resume a single worker so it stops/resumes taking on new jobs (its current job keeps going).
export function setPaused(runnerId, paused, options) {
    return client.post("runners/pause", { runnerId, paused }, options);
}
