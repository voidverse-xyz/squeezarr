// Shared domain enums — the string contracts that cross the wire between the Express
// backend and the Next.js frontend. Both workspaces depend on the `shared` package and
// import this as `shared/domain.js`. Centralized so a typo surfaces as `undefined` (loud)
// instead of a string that silently never matches.

// Background-queue job types. These values are also the i18n keys in strings.js (jobTypes).
export const JOB_TYPE = {
    SCAN_DIRECTORY: "SCAN_DIRECTORY",
    PROBE_FILE: "PROBE_FILE",
    TRANSCODE_FILE: "TRANSCODE_FILE",
};

// Lifecycle status of a queue job (job.js).
export const JOB_STATUS = {
    pending: "pending",
    running: "running",
    done: "done",
    failed: "failed",
};

// Lifecycle status of a scanned media file (the "files" collection).
export const FILE_STATUS = {
    pending: "pending",
    queued: "queued",
    processing: "processing",
    transcoded: "transcoded",
    replaced: "replaced",
    failed: "failed",
    rejected: "rejected",
    stopped: "stopped",
    ignored: "ignored",
};

// Status of a single transcode-result entry (file.transcodeResults[]).
export const RESULT_STATUS = {
    done: "done",
    failed: "failed",
    rejected: "rejected",
    replaced: "replaced",
};

// Where a transcode setting writes its output.
export const OUTPUT_MODE = {
    adjacent: "adjacent",
    overwrite: "overwrite",
};

// Built-in post-transcode filter identifiers (see services/filters.js).
export const FILTER_ID = {
    acceptMinimalSize: "accept-minimal-size",
    sameFile: "same-file",
};

// Work status of a connected transcode runner. A runner is the process that actually drives
// ffmpeg; the monitor hands transcodes to idle runners over a WebSocket. Runners aren't
// persisted — the runner pool tracks them in memory and drops them on disconnect, so there's no
// "offline" state (a runner is either connected-and-idle or connected-and-busy).
export const RUNNER_STATUS = {
    idle: "idle",
    busy: "busy",
};

// Database collection names and the id of the singleton settings document. (Runners are NOT
// persisted — they're ephemeral WebSocket connections tracked in memory by the runner pool.)
export const COLLECTION = {
    files: "files",
    jobs: "jobs",
    settings: "settings",
};
export const SETTINGS_DOC_ID = "main";

// Statuses accepted by the stop API and exposed by dashboard controls.
export const STOPPABLE_STATUSES = [FILE_STATUS.pending, FILE_STATUS.queued, FILE_STATUS.processing];

// File statuses a file can be re-queued from — shared by the requeue API (backend) and the
// dashboard's requeue button (frontend) so the two never drift.
export const REQUEUEABLE_STATUSES = [
    FILE_STATUS.failed,
    FILE_STATUS.transcoded,
    FILE_STATUS.rejected,
    FILE_STATUS.replaced,
    FILE_STATUS.ignored,
    FILE_STATUS.stopped,
];
