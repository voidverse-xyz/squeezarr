# Squeezarr architecture

Self-hosted video transcoding manager, split into an **Express backend** and a **Next.js
frontend** as npm workspaces (`backend/`, `frontend/`, plus a tiny `shared/` for cross-wire
enums + the response envelope). The backend runs an in-process job queue that drives `ffmpeg`,
owns the database, and also serves the prebuilt frontend; all state is in MongoDB. This doc is
the map; the code is the source of truth.

## Process model

`backend/server.js` is the entry (`node backend/server.js`). It runs in one of two modes,
selected by the `HOST_IP` env var (see **Monitor / runner** below):

- **monitor** (no `HOST_IP`) — the full app described here, plus an in-process runner.
- **runner-only** (`HOST_IP` set) — starts _nothing_ below; it only connects a runner to the
  monitor at `HOST_IP` and drives ffmpeg.

On boot the **monitor** does:

1. `mongo.start()` — spawns a **local `mongod`** (see Storage).
2. `db.connect()` — connects the MongoDB driver and creates indexes.
3. `processing.initialize()` + `recoverStuckFiles()` — resets files left `processing` by a
   crash back to `pending`.
4. `settings.initialize()`.
5. Registers scan/probe handlers, starts the queue (`event.initialize()`), enqueues a first
   scan, and sets the auto-scan interval.
6. Starts the HTTP server (port 3000) from the Express app that `server.js` wires (`/api`
   routers + the prebuilt static UI), attaches the runner WebSocket server to it, and starts the
   in-process local runner connecting back over loopback.

The backend is **one plain Node process** (no bundler), so module-scope state is shared
normally — `database.js` connects lazily via a plain module-level promise (see Storage). A
transcode's cancellation is still carried by a durable DB field (`cancelled`) — not for module
reasons, but because the cancel must reach a possibly-**remote** runner process over the
WebSocket and `finalizeTranscode` checks the durable flag (see Locks).

The **frontend** is a separate Next.js workspace built to a static export (`output: "export"`,
`frontend/out`); the backend serves it for all non-`/api` routes, so the fetch client
(`frontend/src/api/*`) stays same-origin (`/api/...`) with no CORS.

`SIGTERM`/`SIGINT` and post-start fatal callbacks join one idempotent shutdown coordinator. Its
synchronous barrier marks readiness stopping, rejects new HTTP/upgrades, stops auto-scan, disables
runner registration/assignment, closes the HTTP listener, and stops/wakes the queue. It then drains
admitted HTTP requests and the queue loop, closes the local runner and runner sockets, and awaits
each socket's serialized result/finalization-or-close-recovery chain. API route handlers are
wrapped with `trackRequestHandler`, so a disconnected response does not release the request until
its async controller work actually settles. Only after those handlers
settle does it close Mongoose and then stop the local mongod. A global 30-second deadline
force-closes transports and exits nonzero rather than closing persistence beneath known handlers.

## Storage (MongoDB)

Persistence uses **Mongoose**. `backend/database/schemas/` holds the schemas — one file each
for files, jobs, settings, runners (re-exported from `schemas/index.js`) — which are the single
source of truth for each document's shape, defaults, and indexes. Schema modules export plain
functions: `getSchema()`, `getName()` (the collection name), and `getIdField()` (the
application-id field name). The `backend/database/` package is the only thing that talks to
the database, split by responsibility: `connection.js` (connect/close), `models.js` (model
compilation + `getIdField`/`defaults`), and `facade.js` (the collection-keyed `db.*`
CRUD: `add / get / update / patch / exists / remove / getAll / find`), re-exported from
`index.js`. Read-modify-write `update(coll, id, fn)` is safe because the facade serializes the
complete read/callback/replacement sequence per collection/application-id in this single process.

- Each collection carries its own indexed application-id field — `fileId` (sha1 of the path),
  `jobId` (uuid), `settingsId` (the `"main"` singleton) — declared via `getIdField()`. Mongo's
  `_id` is left as an auto-generated ObjectId the app never reads or writes; the facade keys
  every read/write off the id field and projects `_id` out of reads (`{ _id: 0 }`), so callers
  work with `{ fileId, ... }` (no generic `id`).
- Defaults live in the schema, not at call sites: `db.add(COLLECTION.files, fileId, { path, size })`
  is enough — the schema fills `status`, timestamps, `transcodeResults`, etc.
- Collections (`shared/domain.js` → `COLLECTION`): `files`, `jobs`, `settings`. Runners are
  **not** persisted — they're ephemeral WebSocket connections the runner pool tracks in memory
  (see Monitor / runner).
- Mongoose owns the connection; the connect promise is a plain module-level singleton in
  `connection.js` (one connection, one connect log line), cleared on failure so the next call
  retries.
- `mongo.js` runs a single local `mongod` (dbpath `CONFIG_DIR/mongodb`, bound to loopback)
  and the app connects to `127.0.0.1:27017`, db `squeezarr` — host/port/db are fixed, no env
  knobs. This is a single-instance app — no other app instance ever shares this database.

## Job queue

A single in-process loop (`backend/services/event.js`):

- `enqueue(type, payload)` → `job.create` writes a `pending` job document, then `wakeup()`
  resolves the idle wait so the loop reacts immediately.
- `processLoop()` reads pending jobs and splits them: **scan/probe** drain in-process and
  sequentially via `runPendingJobs()`; **transcodes** are handed to idle runners via
  `dispatchTranscodes()` (one per runner, in parallel — they don't block the loop). When there's
  nothing to do it sleeps in `waitForWork()` (woken by `enqueue`, or by the runner pool when a
  runner connects/frees, or after `QUEUE_IDLE_WAIT_MS`).
- `job.claim` moves a job `pending → running`, returning `null` if it's no longer pending
  (e.g. already handled earlier in the same batch).
- `SCAN_DIRECTORY`/`PROBE_FILE` handlers are registered by type in `backend/server.js`; an unknown type
  fails the job loudly. `TRANSCODE_FILE` is **not** a handler — it's dispatched to a runner (see
  Monitor / runner).

### Pause semantics (`processingPaused`)

A durable setting (in the `settings` doc) gating the **whole** pipeline. Two checks:

- top of each loop pass: if paused, sleep without listing jobs;
- **before each new start:** if paused, stop. The flag read at the top of a pass goes stale
  during a long pass, so this re-check is what makes a pause landing mid-pass actually withhold
  the next start. Both `runPendingJobs` (scan/probe) and `dispatchTranscodes` (transcodes)
  re-check; work already in flight finishes, only new starts/assignments are withheld.

This is the bug that `backend/tests/event.test.js` (scan/probe) and `backend/tests/dispatch.test.js` (transcodes)
guard — keep those tests green.

Pause does **not** kill an in-flight ffmpeg; stopping a specific running file is the
separate cancel path (`processing.cancel` + the file's `cancelled` flag — see Locks).

## Pipeline

`SCAN_DIRECTORY → PROBE_FILE → TRANSCODE_FILE`, each stage enqueuing the next:

- **Scan** (`scanner.js`): walk `dataDir` for video extensions, skip known transcode
  outputs, create a `files` doc per new path (`fileId = sha1(absolute path)`, status `pending`),
  enqueue a probe per pending file, then `reconcileQueuedFiles` re-drives anything stuck in
  `queued`.
- **Probe** (`probe.js`): run `ffprobe`, set status `queued`, enqueue a transcode per
  matching enabled setting — or set `ignored` if none match.
- **Transcode** (`ffmpeg.js`, split across the monitor/runner boundary): `prepareTranscode`
  (monitor) sets `processing`, builds the output path + ffmpeg command, and hands it to a runner;
  the runner spawns ffmpeg; `finalizeTranscode` (monitor) runs after the runner reports its
  result — records the result and sets `transcoded` (adjacent) or `replaced` (overwrite).
  Terminal — enqueues nothing.

File statuses (`FILE_STATUS`): `pending → queued → processing →
transcoded | replaced | failed | rejected | stopped | ignored`.

## Monitor / runner

Transcoding is split so it can scale horizontally. The **monitor** does all the orchestration
(scan, probe, queueing) and owns the database; **runners** are pure ffmpeg executors that connect
to the monitor over a WebSocket and never touch MongoDB. `HOST_IP` (from compose) selects the
process role (see Process model). Without it you still get one local in-process runner, so the
single-box and multi-host cases share one code path.

- **Shared storage is required.** Every runner mounts the **same `/data`** as the monitor. The
  runner reads the source and writes the output to the same paths the monitor sees, so only the
  ffmpeg command crosses the wire (never video), and the monitor does the post-ffmpeg filesystem
  work (filters, rename, stat) after the runner exits.
- **WS server (`runnerpool.js`, monitor):** attaches to the HTTP server on `RUNNER_WS_PATH` (one
  port). Tracks connected runners in an **in-memory** Map (no DB — they're ephemeral; `list()`
  snapshots it for the read API). `assign` hands a prepared transcode to an idle runner;
  `relayCancellations` turns a file's `cancelled` flag into a `cancel` message; on a `result` it
  calls `finalizeTranscode` + completes the job; on a runner disconnect mid-transcode it drops the
  runner from the Map and **requeues** the file (`pending`) and job.
- **Per-runner pause:** `setPaused(runnerId, paused)` (exposed via `POST /api/runners/pause`,
  surfaced by the pause button on each Workers-tab card) flips an in-memory `paused` flag.
  Dispatch only ever picks a runner via `isAvailable()` (idle **and** not paused **and** socket
  open), so a paused runner finishes its current job and then takes no new ones until resumed;
  `markIdle` deliberately preserves `paused` across jobs. This is orthogonal to the **global**
  `processingPaused` flag, which rests the whole pipeline.
- **WS client (`runner.js`, runner):** on `assign`, spawns ffmpeg against the shared path, streams
  `progress` + a `heartbeat` (`RUNNER_HEARTBEAT_MS`, recorded on the in-memory runner record),
  obeys `cancel` (SIGTERM→SIGKILL), and reports a `result`. It reconnects with exponential backoff; a remote
  runner that can't reach the monitor within `RUNNER_CONNECT_MAX_MS` exits (the local in-process
  runner never exits — that would kill the monitor).
- **Concurrency = number of connected runners.** Each runner does one transcode at a time; scan
  and probe stay sequential in the monitor.
- **Identity:** a runner is identified only by `runnerId` (a per-process uuid), used solely to
  track who is transcoding and to record its heartbeat. No `serverId` is stamped on file/job docs.
  For display, the runner reports a `hostname` in its register `info`; set the `NODE_NAME` env var
  to override it with a friendly label in the Workers UI (defaults to the OS/container hostname).

## Lifecycle serialization

There are two in-process serialization layers, both relying on the single-monitor invariant rather
than database lock documents or distributed coordination:

1. `backend/database/facade.js` keeps a FIFO mutation tail per collection/application-id. The
   complete `add`, `update` read/callback/replacement, and `remove` operation holds that turn;
   `patch` delegates to `update`. Snapshot reads remain concurrent, and different document IDs can
   mutate concurrently. A mutation callback must not recursively mutate its own collection/id.
2. `backend/services/processing.js` keeps a per-file lifecycle section for protocols spanning file
   state, job state, and filesystem effects. When both layers are needed, ordering is always
   **file lifecycle section → job mutation**. A job mutation callback must never wait for that same
   file section.

The document FIFO prevents stale whole-document replacement from overwriting terminal job state,
ownership, cancellation, or newer result data. The wider file section prevents Stop, requeue,
runner-loss recovery, and finalization from crossing multi-step side-effect boundaries; aggregate
status recomputation holds it across both the active-job snapshot and file write. These are
process-local correctness tools, not cross-monitor locks.

- `cancel(fileId)` sets the file's durable `cancelled` field (and `stop` also sets status
  `stopped`). The transcode runs in a runner process, so the monitor can't kill ffmpeg directly:
  the event loop relays the flag to the runner as a `cancel` message
  (`runnerpool.relayCancellations`). The durable DB flag is the bridge because the runner is a
  separate (possibly remote) process and `finalizeTranscode` checks the flag — not cross-VM
  coordination. The relay runs at the **top of `processLoop`, before the global-pause gate** (so a
  stop reaches a busy runner even while processing is paused), and the `stop` controller calls
  `eventService.wakeup()` so the cancel goes out immediately instead of after the idle timeout.
- On boot, lifecycle recovery reconciles journals and stuck files. A runner dying while the monitor
  lives is handled by runner-loss recovery, conditional on both a running job and its matching
  active file owner.

## Deployment

State lives in MongoDB; media in `/data`; app config in `/config`.

One image, one process: the multi-stage `Containerfile` builds the frontend static export and the
backend's production deps, then the final image runs `node backend/server.js` (it serves both
`/api` and the prebuilt UI on port 3000, with `FRONTEND_DIR` pointing at the copied `frontend/out`).
The container bundles `mongodb-org-server`; the **monitor** runs a single local mongod (data under
the `/config` volume, bound to loopback only — nothing outside the container ever connects
to it). The container images are Debian **bookworm** based — required because MongoDB has
no official Alpine/musl build. `compose.yaml` + `Containerfile.local` build the app for local use;
`Containerfile` is the hardened production image.

The same image runs a **runner-only** process when `HOST_IP` is set (`compose.yaml` has an optional
`runner` service, scalable with `--scale runner=N`). A runner mounts only the shared `/data` (no
`/config`, no mongod, no exposed port) and reaches the monitor at `HOST_IP` over the WebSocket. Set
`NODE_NAME` on a runner (or the monitor) service to give it a friendly label in the Workers UI.
Compose grants monitor and runner containers a 40-second stop grace period; equivalent direct
container runs must use `--stop-timeout 40`, leaving the application deadline time to drain before
the runtime sends SIGKILL.

## Tests

`docker compose run --rm --no-deps app npm test` runs the Node built-in test runner (`node --test`)
inside the dev image — no database needed; queue collaborators are injected. Rebuild the dev image
after source or package changes before running one-off checks. The queue's batch/pause/claim logic
lives in the exported `runPendingJobs` (scan/probe) and `dispatchTranscodes` (transcodes) precisely
so they stay unit-testable; the runner reconnect backoff is a pure exported `backoffDelay`. Add
tests alongside as `backend/tests/*.test.js`.
