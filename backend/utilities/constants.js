// Server-side configuration constants for the Express backend (timings, ports, pagination).
// UI-only constants (Tailwind class maps, tabs, filter pills) live in the frontend package.
// (DB internals are backend-only and deliberately NOT in the `shared` package — the frontend
// must never know how to reach Mongo.)

// --- MongoDB ---
// Single bundled local mongod, loopback only, fixed host/port/db (no env knobs) — the one place
// these values live, so `mongo.js` (spawns mongod) and `database/connection.js` (the driver URI)
// can't drift. The on-disk dbpath derives from CONFIG_DIR at runtime (see mongo.js).
export const MONGO_HOST = "127.0.0.1";
export const MONGO_PORT = 27017;
export const MONGO_DB = "squeezarr";
export const MONGO_URI = `mongodb://${MONGO_HOST}:${MONGO_PORT}/${MONGO_DB}`;

// --- Monitor / runner WebSocket ---
// Runners connect to the monitor's HTTP server (the fixed app port) over this upgrade path —
// one port to expose. The monitor and every runner share the same /data mount, so only the
// ffmpeg command crosses the wire, never video.
export const RUNNER_WS_PATH = "/ws/runner";
// While a runner transcodes it sends a heartbeat this often; the monitor records it on the
// runner's DB doc so a stalled/dead runner is visible.
export const RUNNER_HEARTBEAT_MS = 5_000;
// A connection that misses four complete heartbeat periods is considered lost. The pool watchdog
// checks once per heartbeat period and terminates stale sockets so ordinary serialized close
// recovery owns the transition. Keeping timeout and cadence separate makes the bound explicit.
export const RUNNER_HEARTBEAT_TIMEOUT_MS = RUNNER_HEARTBEAT_MS * 4;
export const RUNNER_WATCHDOG_MS = RUNNER_HEARTBEAT_MS;
// Runner connect backoff: exponential from BASE to MAX; a runner-only process gives up and
// exits if it cannot connect within RUNNER_CONNECT_MAX_MS (5 minutes).
export const RUNNER_BACKOFF_BASE_MS = 1_000;
export const RUNNER_BACKOFF_MAX_MS = 30_000;
export const RUNNER_CONNECT_MAX_MS = 5 * 60 * 1000;
// Bound each individual TCP/WebSocket handshake too. Some network blackholes emit neither error
// nor close, so the streak-level give-up/retry policy cannot advance without this deadline.
export const RUNNER_CONNECT_ATTEMPT_TIMEOUT_MS = 30_000;
// Once the monitor-local runner has been disconnected longer than the remote give-up window, it
// continues reconnecting forever but emits at most one extended-outage warning per interval.
export const RUNNER_OUTAGE_WARNING_MS = 5 * 60 * 1000;

// ffprobe is untrusted input processing and must never hold the sequential queue indefinitely.
// execFile enforces this wall-clock budget and force-kills the process when it expires.
export const FFPROBE_TIMEOUT_MS = 30_000;

// --- Graceful shutdown ---
// Docker gets a longer grace period than the application deadline, leaving time for the bounded
// WebSocket handshake fallback and final process exit before the runtime sends SIGKILL.
export const RUNNER_SOCKET_CLOSE_TIMEOUT_MS = 5_000;
export const SHUTDOWN_DEADLINE_MS = 30_000;

// Pagination: default page size and the hard cap the API enforces.
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
