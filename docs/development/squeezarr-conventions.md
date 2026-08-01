# Squeezarr development conventions

Squeezarr is an npm-workspace project with an Express backend, a statically exported Next.js
frontend, and a small shared cross-wire contract. The root [`AGENTS.md`](../../AGENTS.md) is
authoritative when this guide and the code disagree.

## Repository structure

- `shared/` contains enums and response-envelope helpers imported by both applications.
- `backend/` contains the Express server, routes, controllers, services, database facade, utilities, and tests.
- `frontend/` contains App Router pages, UI components, API clients, hooks, contexts, and client utilities.
- `docs/architecture/` contains the system design reference.
- `docs/assets/` contains documentation images.

## General rules

- Put user-facing frontend text in `frontend/src/lib/strings.js`.
- Put client UI constants in `frontend/src/lib/constants.js`.
- Put server configuration in `backend/utilities/constants.js` and `backend/utilities/config.js`.
- Put cross-wire enums and collection names in `shared/domain.js`.
- Prefer platform built-ins before adding dependencies.
- Let Prettier own formatting; do not hand-tune wrapping.

## Imports

- Import shared modules by package name: `shared/domain.js` and `shared/response.js`.
- Use relative imports within the backend.
- Use the `@/` alias for imports within the frontend.
- Import backend controllers and services through their barrels under namespaced aliases.

## Backend request flow

The backend flow is:

```text
route → controller → service → database facade
```

- Routes sanitize request values using `backend/utilities/sanitize.js`.
- Controllers validate business rules and return the `{ success, output, data }` envelope from `shared/response.js`.
- Expected validation failures return an unsuccessful envelope rather than throwing.
- The API router's final error handler converts unexpected errors into a 500 envelope.
- Log through the logging service rather than `console`.
- Only `backend/database/` communicates with MongoDB.

## Database conventions

- Mongoose schemas under `backend/database/schemas/` define document shapes, defaults, and indexes.
- Collections use their application ID fields (`fileId`, `jobId`, or `settingsId`) rather than MongoDB's `_id`.
- Pass only meaningful values to `db.add`; let schemas supply defaults.
- Keep the single-instance model: one backend process owns one local MongoDB instance.
- Runners are ephemeral WebSocket executors and never access MongoDB directly.

## Frontend conventions

- Reuse shared UI primitives such as `Card`, `EmptyState`, and `SectionHeader`.
- Keep one-off UI local; extract components only when repetition is real.
- Pair icons and adjacent text with `items-center`.
- Use `cn()` when combining conditional class names.
- Keep API access in `frontend/src/api/` and reusable state in hooks and contexts.

## Important invariants

- A global pause prevents new work even when it arrives during a batch; already-running work may finish.
- Transcode output paths must never be rediscovered as source files.
- Schemas remain the source of truth for stored defaults and indexes.
- The Mongoose connection is lazy and shared by the single backend process.
- File cancellation remains durable so it can reach a remote runner.

## Publishing container images

The release helper builds the production `Containerfile` with Podman, transfers the image into
Docker, and pushes `voidversexyz/squeezarr:latest`. Authenticate Docker before publishing, then
run:

```bash
./publish.sh
```

Publishing replaces the existing `latest` image.

## Verification

Run the project checks from the repository root inside the development container:

```bash
docker compose build app
docker compose run --rm --no-deps app npm test
docker compose run --rm --no-deps app npm run lint
docker compose run --rm --no-deps -v .:/work app /server/node_modules/.bin/prettier --write /work
```

Rebuild after package or frontend changes. Backend and shared source changes can use Compose watch during development.
