# Squeezarr — working notes

Self-hosted video transcoding manager, split into an **Express backend** and a **Next.js
frontend** as npm workspaces. The backend (`backend/server.js`, run as `node
backend/server.js`) owns mongod, the in-process job queue driving `ffmpeg`, the runner-pool
WebSocket server, and the REST API — and also serves the prebuilt frontend. The frontend
(`frontend/`) is a pure static client (`output: "export"`). All state lives in MongoDB.
Full picture: `docs/architecture/architecture.md`.

> This file (`AGENTS.md`) is the committed source of truth for project working notes.

## Committing — no private or sensitive data

Never commit private or sensitive information: no secrets, tokens, credentials, API keys,
emails, personal paths, or private/LAN IPs. Machine-local config is gitignored; the committed
source of truth lives in this root `AGENTS.md`. Use the relevant privacy checks before committing.

## Layout (npm workspaces)

- `shared/` — the cross-wire contract both sides import as `shared/domain.js` (enums,
  `COLLECTION`, `REQUEUEABLE_STATUSES`) and `shared/response.js` (the `{ success, output, data }`
  envelope `getResult`).
- `backend/` — Express server. `server.js` (entry at the backend root: monitor + runner-only
  modes; also wires the Express app — `/api` routers + the static UI), `routes/*` (one router
  per resource), `controllers/*`, `services/*` (including deep-payload validation), `database/*`,
  `utilities/*` (server-only: `constants.js`, `sanitize.js`,
  `config.js` (env-sourced paths + the ffmpeg-flag allowlist), `scanpath.js`), `tests/*`.
- `frontend/` — Next.js UI. `src/app` pages, `src/components`, `src/hooks`, `src/context`,
  `src/api/*` (the fetch client, same-origin `/api/...`), `src/lib/*` (client-only:
  `constants.js`, `strings.js`, `utils.js`).
- `docs/` — organized project documentation: `architecture/` for system design,
  `development/` for contributor guidance, and `assets/` for logos and screenshots. See
  `docs/README.md`; this file remains the authoritative source for automated contributor
  instructions.

## Commands (run from repo root)

- `docker compose up --build --watch app` — dev app on :3001; Compose syncs backend/shared changes
  into the container and rebuilds for frontend/package changes
- `docker compose build app` — rebuild the local/dev image after source or package changes before
  one-off checks
- `docker compose run --rm --no-deps app npm test` — backend unit tests inside the dev image
  (Node built-in runner, no database needed)
- `docker compose run --rm --no-deps app npm run lint` — ESLint over **both** workspaces inside
  the dev image
- `docker compose run --rm --no-deps -v .:/work app /server/node_modules/.bin/prettier --write /work` —
  Prettier across the repo using the dev image; run before finishing
- `npm start` — production without Docker: backend on :3000 serving `/api` + the built UI

Env: `NODE_NAME` (optional) overrides a runner's display name in the Workers UI — set it per
container in `compose.yaml`; defaults to the OS/container hostname. `SQUEEZARR_PASSWORD` is
required on the monitor for UI/API login. `SQUEEZARR_RUNNER_TOKEN` is required on the monitor and
runner-only containers for runner WebSocket auth; keep it distinct from the admin password.

## Conventions

- **No hardcoded display text.** User-facing strings go in `frontend/src/lib/strings.js`;
  client UI config/enums in `frontend/src/lib/constants.js`; server config in
  `backend/utilities/constants.js`; cross-wire enums in `shared/domain.js`.
- **Imports:** backend (plain Node ESM) and frontend both import the cross-wire contract by
  package name — `shared/domain.js`, `shared/response.js`. Within the backend use relative
  paths; the frontend uses its `@/` alias (→ `frontend/src`). There is no `@/` in the backend.
- The data layer under `backend/database/` is the only code that talks to MongoDB; each
  collection is keyed by its own indexed application-id field (`fileId` / `jobId` /
  `settingsId`), not Mongo's `_id`. (Runners aren't persisted — the runner pool keeps them in
  memory; see `services/runnerpool.js`.)
- This is a **single-instance app**: one backend process, one local mongod, nothing else ever
  connects to the database. Don't reintroduce cross-instance coordination (lock documents,
  `serverId` stamping, atomic claim/create-once primitives). Plain read-then-write is correct only
  inside the database facade's per-document in-process FIFO serializer; wider file/job/filesystem
  lifecycle protocols also use the per-file section, ordered **file lifecycle section → job
  mutation**.
- **Backend request flow:** routes are plain Express handlers — pull `req.body`/`req.query`, run
  each field through a `utilities/sanitize.js` coercer (`sanitize.text`/`bool`/`int`/`enum`/`list`, which
  never throw), call the controller, `res.send(result)`. The controller **validates** (business
  rules, plus the deep settings payload via `settingsValidationService.validateSettings`, which
  returns `{ error }` | `{ value }`) and **returns** the `getResult(success, output, data)` envelope
  (`shared/response.js`) — never throws, never branches on error kind, so a validation error rides
  back as `{ success: false, output: "invalid_<field>" }`. The `/api` router ends with one error
  handler — a safety net that renders an unexpected throw as a 500 envelope. Log through
  `loggingService.log(tag, msg)`, not `console`. `GET /api/health` and `/api/auth/*` are public;
  all other `/api` routes require a bearer session token from `/api/auth/login`.
  Services/controllers are imported via the barrels under namespaced `<x>Service` /
  `<x>Controller` aliases. Wrap every async API route handler with `trackRequestHandler` from
  `services/shutdown.js`; shutdown uses that promise boundary to avoid closing Mongo after a client
  disconnects while controller work is still active.
- **UI building blocks:** reuse the shared primitives — `components/ui/card.js` (`Card`, the
  `bg-card border border-border rounded` panel), `components/emptystate.js`,
  `components/sectionheader.js` — instead of re-typing the markup. Keep single-use bits local
  (KISS); only extract on real repetition (DRY). Pair lucide icons with text using
  `items-center`.
- **Prefer built-ins** before adding a dependency (`crypto.randomUUID`, native `fetch`, `Intl`,
  Node test runner are already used in place of libraries).
- **Style is Prettier's job** (printWidth 120, 4-space): run the Docker Prettier command above and don't hand-tune
  wrapping.

## Invariants that have bitten before (keep the tests green)

- **Queue pause** (`processingPaused`): pausing must stop _new_ jobs even mid-batch; the job
  already running finishes. Logic is in `runPendingJobs` (`backend/services/event.js`),
  guarded by `backend/tests/event.test.js`. Don't move the per-job pause check back out of the loop.
- **Scan output exclusion:** transcode outputs must never be re-scanned as sources.
  `backend/utilities/scanpath.js` (`collectKnownOutputPaths` / `findStrayOutputDocs`) holds that
  rule — it covers finished outputs and in-flight `currentOutputPath`, and removes stray docs
  left by an interrupted transcode. Tested in `backend/tests/scanpath.test.js`.
- **Schemas are the source of truth:** document shape, defaults, and indexes live in the
  Mongoose schemas under `backend/database/schemas/` (`file.js` / `job.js` / `settings.js`,
  one per model, re-exported from `schemas/index.js`). Don't re-add default-field
  literals at call sites — pass only the meaningful fields to `db.add` and let the schema fill
  the rest. The data layer is split by responsibility: `connection.js` (connect/close),
  `models.js` (model compilation + `getIdField`/`defaults`), `facade.js` (the
  collection-keyed `db.*` CRUD: `get/add/update/patch/getAll/remove/exists/find`), re-exported from
  `database/index.js`. Each schema declares its application-id field via `getIdField()`; the
  facade keys every read/write off that field and projects Mongo's auto-generated `_id` out of
  reads (it can't be disabled on a root doc, only excluded — `{ _id: 0 }`). So
  `db.get(COLLECTION.files, fileId)` → `findOne({ fileId })`, and callers see `fileId`,
  never a generic `id`.
- **Lazy DB connect:** Mongoose owns the single connection. The backend is one plain Node
  process, so the connect promise is a plain module-level singleton in `connection.js` (one
  connection, one connect log; clears on failure so the next call retries). `processing.js` still
  bridges file cancellation through a durable DB field (`cancelled`) — not because of any
  module-duplication, but because the cancel must reach a possibly-**remote** runner over the
  WebSocket and `finalizeTranscode` checks the durable flag.
- **Mongo deployment:** the backend always runs its own local mongod (loopback only). Images
  are Debian bookworm (no official MongoDB build for Alpine).
