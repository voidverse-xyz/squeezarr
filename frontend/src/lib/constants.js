import { OUTPUT_MODE, FILTER_ID } from "shared/domain.js";

// UI-only constants for the Next.js frontend (display order, Tailwind class maps, polling).
// Server config (runner WS timings, pagination caps) lives in the backend package.

// How often the dashboard polls for updates (ms)
export const POLL_INTERVAL = 5_000;

// Every browser request is bounded. Callers can shorten this for a specific operation, but
// mutations are never replayed automatically when this deadline expires.
export const REQUEST_TIMEOUT_MS = 15_000;

// Default page size the dashboard requests (the backend enforces its own default/cap).
export const DEFAULT_PAGE_SIZE = 50;
// How many recent jobs the dashboard requests for the Jobs tab.
export const JOBS_FETCH_LIMIT = 30;

// Tailwind color classes for each file / job / worker status — labels live in strings.js
export const STATUS_CLS = {
    queued: "text-blue-400 bg-blue-400/10",
    processing: "text-purple-400 bg-purple-400/10",
    // Worker statuses (Workers tab).
    idle: "text-emerald-400 bg-emerald-400/10",
    busy: "text-purple-400 bg-purple-400/10",
    transcoded: "text-teal-400 bg-teal-400/10",
    replaced: "text-green-400 bg-green-400/10",
    failed: "text-red-400 bg-red-400/10",
    rejected: "text-orange-400 bg-orange-400/10",
    stopped: "text-amber-400 bg-amber-400/10",
    ignored: "text-muted-foreground/50 bg-muted/20",
    pending: "text-muted-foreground bg-muted/40",
    running: "text-yellow-400 bg-yellow-400/10",
    done: "text-green-400 bg-green-400/10",
};
export const DEFAULT_STATUS_CLS = "text-muted-foreground bg-muted/40";

// Stat card keys in display order
export const STAT_CARD_KEYS = ["total", "queued", "processing", "done"];

// Status filter values in display order
export const STATUS_FILTERS = [
    "all",
    "done",
    "transcoded",
    "queued",
    "processing",
    "replaced",
    "stopped",
    "failed",
    "rejected",
    "ignored",
];

// Tab keys, in display order. The URL `tab` param uses these keys verbatim (see page.js), so a
// param is valid iff it's in this list.
export const TABS = ["files", "jobs", "stats", "workers"];

// Tailwind classes for status filter pills (active vs inactive)
export const FILTER_PILL_CLS = {
    done: {
        active: "border-green-500/50 bg-green-500/10 text-green-400",
        inactive: "border-green-500/20 text-green-400/60 hover:border-green-500/40 hover:text-green-400/80",
    },
    transcoded: {
        active: "border-teal-500/50 bg-teal-500/10 text-teal-400",
        inactive: "border-teal-500/20 text-teal-400/60 hover:border-teal-500/40 hover:text-teal-400/80",
    },
    queued: {
        active: "border-blue-500/50 bg-blue-500/10 text-blue-400",
        inactive: "border-blue-500/20 text-blue-400/60 hover:border-blue-500/40 hover:text-blue-400/80",
    },
    processing: {
        active: "border-purple-500/50 bg-purple-500/10 text-purple-400",
        inactive: "border-purple-500/20 text-purple-400/60 hover:border-purple-500/40 hover:text-purple-400/80",
    },
    replaced: {
        active: "border-green-500/50 bg-green-500/10 text-green-400",
        inactive: "border-green-500/20 text-green-400/60 hover:border-green-500/40 hover:text-green-400/80",
    },
    _default: {
        active: "border-primary bg-primary/10 text-primary",
        inactive: "border-border text-muted-foreground hover:border-foreground/30",
    },
};

// Output mode keys — labels live in t.outputModes
export const OUTPUT_MODE_KEYS = Object.values(OUTPUT_MODE);

// Post-transcode filter IDs — names/descriptions live in t.filters
export const FILTER_IDS = Object.values(FILTER_ID);

// Whether each confirm action type is destructive (danger styling)
export const CONFIRM_DANGER = {
    delete: true,
    replace: false,
    stop: false,
    deleteOutput: true,
};
