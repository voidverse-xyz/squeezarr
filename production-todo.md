# Production Readiness TODO — Blockers 2–5

Status: **combined integration verified** — Blockers 2, 4, and 5 are integrated and independently reviewed; Blocker 3 is deferred.

## Current completion summary

- [x] Blocker 2 — integrated and verified.
- [ ] Blocker 3 — deferred; the experimental branch failed the filesystem-safety release gate and is excluded.
- [x] Blocker 4 — integrated and verified.
- [x] Blocker 5 — integrated and verified with deterministic controller-level frontend coverage.
- [ ] Overall production release — still blocked by Blockers 1, 3, and 6 and by the unavailable container/browser smoke environments.

This checklist covers the production-readiness findings requested from the audit:

- **2 — Lifecycle atomicity**
- **3 — Remaining data-loss windows**
- **4 — Incomplete graceful shutdown**
- **5 — Operational gaps**

It intentionally does **not** cover blocker 1 (runner transport/trust security) or blocker 6
(container and volume validation). Completing this file alone will therefore **not** make the
application production-ready.

## Requirements

1. Preserve the single-monitor architecture. Do not add cross-instance locks, lock documents, or
   distributed coordination.
2. Prevent stale read/replace operations from resurrecting or overwriting newer lifecycle state.
3. Make every destructive filesystem operation restart-recoverable, identity-checked, and
   no-clobber.
4. Stop accepting new work before shutdown drains active work and closes persistence.
5. Bound probe and browser requests, keep processing capacity recoverable, and surface failures to
   operators.
6. Keep backend controllers envelope-based, frontend display text centralized in
   `frontend/src/lib/strings.js`, and all Mongo access under `backend/database/`.
7. Add deterministic regression tests before enabling each new state transition.

## Implementation order

Execute the work in this order because each phase builds on the previous one:

1. Blocker 2 — make same-document lifecycle mutation ordering reliable.
2. Blocker 3 — build destructive-operation journals on that reliable ordering.
3. Blocker 4 — drain the resulting lifecycle state machines during shutdown.
4. Blocker 5 — add deadlines, capacity readiness, and visible recovery states.
5. Run the combined crash, restart, container, and browser verification matrix.

---

# Blocker 2 — Lifecycle atomicity

> **Status:** Integrated on `production-hardening-integration`; combined verification and independent review passed.

## Current state

- `db.update()` reads, mutates, and replaces a whole document without serializing another mutation
  of the same document (`backend/database/facade.js:32`).
- Job claim, completion, failure, and progress depend on that operation as a conditional state
  transition (`backend/services/job.js:76`, `backend/services/job.js:88`,
  `backend/services/job.js:138`, `backend/services/job.js:195`).
- File lifecycle writes already reuse a keyed in-process critical section
  (`backend/services/processing.js:13`), which is the model to extend without adding
  cross-instance coordination.

## Plan

### 2.1 Serialize same-document mutations in the database facade

- [ ] Add a module-local FIFO mutation-tail map in `backend/database/facade.js`, keyed by
      `collection + application id`.
- [ ] Extract the existing schema-build and `replaceOne` code from `add()` into a private unlocked
      replacement helper.
- [ ] Run the complete `add`, `update` read/callback/write sequence, and `remove` operation through
      the keyed serializer.
- [ ] Keep `patch` delegating to `update`; it must not acquire the same key twice.
- [ ] Leave `get`, `find`, `getAll`, and `exists` as snapshot reads.
- [ ] Release a key in `finally`, including after callback or database failure, and remove idle keys
      so the map does not grow forever.
- [ ] Keep different document IDs concurrent; do not introduce a global database mutex.
- [ ] Document that a mutation callback must not recursively mutate the same collection/id.

**Why:** this reuses the proven single-process FIFO pattern from
`backend/services/processing.js:13` and makes existing job predicates authoritative without
violating the single-instance design.

### 2.2 Make reset decisions from the serialized job transition

- [ ] Refactor `resetTranscode()` in `backend/services/event/dispatch.js` to remove its separate
      pre-read of the job.
- [ ] Decide `reset`, `stopped`, `missing`, or `stale` inside the serialized job update callback.
- [ ] Clear file ownership only if the matching running job actually moved back to pending or was
      terminally settled because the file was stopped/missing.
- [ ] Preserve file ownership when the job is already done or failed so finalization/startup
      recovery remains authoritative.
- [ ] Make the no-file-id branch return `stale` unless `running → pending` occurred.

### 2.3 Audit all lifecycle mutation paths for one lock order

- [ ] Retain `withFileLifecycleCriticalSection()` for operations spanning file state, job state,
      and filesystem effects (`backend/services/processing.js:13`).
- [ ] Standardize nested ordering as **file lifecycle section → job mutation** where both are
      required; never hold a job mutation callback while waiting for the same file lock.
- [ ] Verify stop and requeue preserve their exact captured job generation rather than searching
      again after releasing the file lock (`backend/controllers/files/mutations.js:221`).
- [ ] Verify runner-loss transitions remain conditional on a running job and matching active file
      owner (`backend/services/runnerpool/recovery.js:42`).
- [ ] Verify result upserts and aggregate status recomputation cannot replace newer ownership or
      cancellation fields.
- [ ] Add comments explaining that the per-document serializer prevents stale replacements while
      the per-file section protects wider multi-step lifecycle protocols.

### 2.4 Add deterministic concurrency tests

- [ ] In `backend/tests/database.test.js`, pause the first same-ID mutation after its read and prove
      a second mutation cannot read until the first replacement completes.
- [ ] Prove different IDs can mutate concurrently.
- [ ] Prove a rejected mutation releases the queue for its successor.
- [ ] Test claim-vs-fail, complete-vs-fail, progress-vs-complete, update-vs-remove, and
      reset-vs-complete orderings.
- [ ] In `backend/tests/dispatch.test.js`, cover running, stopped, missing, done, and failed reset
      states.
- [ ] In `backend/tests/core-transcode.test.js`, hold reset at its job boundary while stop,
      completion, or requeue wins; assert no terminal job resurrection and no stale owner clearing.

### 2.5 Update architecture guidance

- [ ] Update `AGENTS.md` without weakening the single-instance/no-cross-instance rule: plain
      read-then-write remains allowed only when same-document mutations are serialized in-process.
- [ ] Update `docs/architecture/architecture.md` with the two lock layers and their ordering.

## Blocker 2 acceptance gate

- [ ] No same-document callback can observe an older version while an earlier same-ID mutation is
      still pending.
- [ ] Terminal jobs never return to pending/running through stale replacement.
- [ ] Stop and immediate requeue cannot affect a newer probe/transcode generation.
- [ ] All focused tests, `npm test`, lint, format, and frontend build pass.

---

# Blocker 3 — Remaining data-loss windows

> **Status: DEFERRED.** Independent review proved that Node's path-based identity/check/unlink API cannot provide the required atomic no-clobber quarantine guarantee. The experimental branch must not be integrated. Resuming this blocker requires an explicit platform decision, such as a Linux `renameat2(RENAME_NOREPLACE)` helper that fails closed on unsupported filesystems.

## Current state

- File removal, output deletion, manual replacement, and requeue modify the filesystem before their
  final database state is durable (`backend/controllers/files/mutations.js:107`,
  `backend/controllers/files/mutations.js:139`, `backend/controllers/files/mutations.js:175`,
  `backend/controllers/files/mutations.js:221`).
- The file schema has adjacent/overwrite journals but no journal for API mutations and no stable
  source identity (`backend/database/schemas/file.js:61`).
- Retained overwrite rejection can publish a result while its journal still has a rollback-class
  phase (`backend/services/ffmpeg/finalize.js:239`, `backend/services/processing.js:565`).

## Plan

### 3.1 Add a reusable stable file-identity contract

- [ ] Add `backend/utilities/file-identity.js` with helpers to capture, compare, and assert regular
      non-symlink file identity.
- [ ] Store `dev`, `ino`, `size`, `mtimeNs`, and `mode` as decimal strings from BigInt `lstat` data;
      omit `ctime` because creating a hard link changes it.
- [ ] Add `activeSourceIdentity` and `mutationJournal` to the file schema.
- [ ] Add `sourceIdentity` to the job schema and `inputIdentity`/`outputIdentity` to transcode
      results.
- [ ] Clear active source identity everywhere ownership is reset, failed, released, or recovered.
- [ ] Define legacy behavior: missing identity fails closed for replacement; legacy journals are
      preserved and marked for operator recovery rather than guessed.

### 3.2 Add API mutation journals and cleanup tombstones

- [ ] Add `backend/services/file-mutations.js` as the only implementation of destructive API file
      state machines.
- [ ] Use one durable `mutationJournal` with phases `prepared`, `applying`, `committed`, and
      `cleaned`.
- [ ] Record operation ID, operation type, exact paths/identities, operation-owned tombstone paths,
      setting ID, and reserved probe job ID where applicable.
- [ ] Add a small cleanup-tombstone collection for path exclusions that must outlive a deleted file
      document, including retired runner-generation paths.
- [ ] Extend scanner exclusion and output-collision ownership to include mutation journals and
      global cleanup tombstones (`backend/utilities/scanpath.js`).
- [ ] Treat `mutationJournal` as unsettled lifecycle state so another destructive action cannot
      start concurrently.
- [ ] On identity ambiguity or a destination collision, retain all known bytes and the journal,
      mark the file failed, and never guess.

### 3.3 Journal delete-output

- [ ] Capture the output identity and persist `prepared` before touching it.
- [ ] Create an operation-owned same-directory hard-link tombstone with `EEXIST` as a hard failure.
- [ ] Recheck identity, unlink only the expected output generation, then persist the result with a
      null output path and a `committed` journal.
- [ ] Mark `cleaned`, identity-delete the tombstone, and clear the journal.
- [ ] Pre-commit recovery restores the output only if its original path is free; a drifted path is
      preserved and reported.

### 3.4 Journal whole-file removal

- [ ] Snapshot the source and all owned output generations under the file lifecycle section.
- [ ] Persist `prepared`, then detach each expected generation to a unique tombstone.
- [ ] Publish permanent cleanup/exclusion tombstones before the file document can disappear.
- [ ] Persist `committed`, identity-delete operation tombstones, and remove the file document last.
- [ ] Roll back all detached generations after a pre-commit crash; finish deletion after a
      committed crash.
- [ ] Never delete a source or output whose identity changed after intent was recorded.

### 3.5 Journal manual replacement

- [ ] Require current source and result output identities to match their persisted identities.
- [ ] Persist `prepared` and `applying` with unique backup ownership before the first unlink.
- [ ] Hard-link the original source to the backup, recheck identity, and install the output with a
      no-clobber link/unlink sequence.
- [ ] Persist installed identity and `committed` before changing result/status metadata.
- [ ] Mark `cleaned`, identity-delete the backup, release ownership, and clear the journal.
- [ ] Pre-commit recovery reconstructs both source and output; committed recovery records exactly
      one replacement.

### 3.6 Journal requeue

- [ ] Reserve operation ID and probe job ID in `prepared`.
- [ ] Detach every tracked output into identity-owned tombstones.
- [ ] In one file mutation, clear results/transient state, set pending, publish the reserved probe
      owner, and mark the journal committed.
- [ ] Fail only the old generation's outstanding jobs.
- [ ] Ensure exactly one matching reserved probe job exists; refuse an existing mismatched job.
- [ ] Clean tombstones, clear the journal, and wake the queue.
- [ ] Roll back before commit without publishing a probe; roll forward after commit without
      duplicating a probe.

### 3.7 Fence every transcode with source identity

- [ ] Capture source identity before preparation and recheck it inside the serialized owner claim.
- [ ] Persist the same identity in the file owner, job, and adjacent/overwrite journal.
- [ ] Require file/job/prepared identity agreement in `preparedTaskMatches()`
      (`backend/services/processing.js:40`).
- [ ] Recheck source identity before and after filters and immediately before promotion/replacement.
- [ ] On drift, preserve the new source, fail the old attempt, and retire its scratch generation.
- [ ] Persist input/output identities in successful and retained results.

### 3.8 Make overwrite and retained rejection identity-aware

- [ ] Replace clobbering overwrite restoration/promotion with identity-classified, no-clobber
      operations (`backend/services/ffmpeg/finalize.js:286`,
      `backend/services/processing.js:496`).
- [ ] Extend overwrite journals with explicit outcome: `replace`, `retain-rejection`, or
      `delete-rejection`.
- [ ] For retained rejection, persist `outcome: retain-rejection` and `phase: committed` before
      publishing the result.
- [ ] Make restart roll forward committed rejection outcomes; never route them through replacement
      rollback or delete the retained output.
- [ ] Preserve journals and artifacts on unexpected identity topology, permission failure, or
      read-only storage.

### 3.9 Centralize startup recovery order

- [ ] Run recovery before queue dispatch, HTTP acceptance, or runner attachment.
- [ ] Recover in this order: API mutation journals → cleanup tombstones → adjacent journals →
      overwrite/rejection journals → journal-less stuck files → interrupted jobs → orphaned probe
      owners.
- [ ] Make every recovery action idempotent; a second restart must produce no additional change.
- [ ] Keep every unresolved journal-owned path excluded from scanning.

### 3.10 Add crash-boundary and drift tests

- [ ] Add `backend/tests/file-mutations.test.js` with injected failures after every durable phase and
      filesystem action for delete-output, remove, replace, and requeue.
- [ ] Run recovery twice from every checkpoint and require identical final state.
- [ ] Test source replacement, output replacement, same-name destination creation, tombstone
      collision, missing targets, symlinks, and permission failures.
- [ ] Extend `backend/tests/core-transcode.test.js` for source drift and every overwrite/rejection
      journal phase.
- [ ] Extend scanner tests to prove no journal, backup, tombstone, or retired path can become a new
      source document.

## Blocker 3 acceptance gate

- [ ] Every destructive operation converges after restart to either the complete old state or the
      complete committed state.
- [ ] Unexpected new files are never overwritten or deleted.
- [ ] A changed source can never be replaced by output generated from an older source identity.
- [ ] Retained rejection output survives every restart checkpoint.
- [ ] No recovery path acts destructively without exact identity evidence.

---

# Blocker 4 — Incomplete graceful shutdown

> **Status:** Integrated on `production-hardening-integration`; combined verification and independent review passed.

## Current state

- Monitor shutdown does not close or await the HTTP server (`backend/server.js:100`,
  `backend/server.js:141`).
- Queue shutdown flips flags but does not return the supervised loop promise
  (`backend/services/event.js:158`).
- Runner-pool shutdown clears registry state before serialized close/result chains are guaranteed to
  finish (`backend/services/runnerpool/server.js:125`).
- Runner shutdown is synchronous and does not await WebSocket close (`backend/services/runner.js:161`).

## Plan

### 4.1 Add an idempotent shutdown coordinator

- [ ] Add `backend/services/shutdown.js` with one cached shutdown promise, global deadline, request
      tracker, injected exit/timer hooks for tests, and error aggregation.
- [ ] Make repeated signals and fatal callbacks join the same promise without restarting deadlines
      or teardown work.
- [ ] Retain `httpServer`, startup promise/state, and started-subsystem flags outside the startup
      closure in `backend/server.js`.
- [ ] Check `shuttingDown` after each startup await so shutdown during startup cannot later open
      HTTP or restart work.

### 4.2 Establish the synchronous acceptance barrier

- [ ] Before awaiting anything: mark readiness stopping, reject new HTTP/upgrade work, stop
      autoscan, disable new runner assignments/registrations, call `httpServer.close()`, and tell the
      queue to stop/wake.
- [ ] Return 503 plus `Connection: close` for a request that races onto an existing keep-alive
      connection after the barrier.
- [ ] Keep already-admitted requests tracked until response `finish` or `close`.

### 4.3 Drain HTTP and queue work

- [ ] Install request tracking before JSON parsing and API routing.
- [ ] Await both the HTTP close callback and active-request count reaching zero.
- [ ] Retain the queue loop promise and make `eventService.shutdown()` idempotently return it.
- [ ] Let the active inline scan/probe finish, but claim no next job.
- [ ] Add shutdown checks around every await in transcode dispatch; reset a claim/owner if shutdown
      wins before assignment.
- [ ] Add a final assignment gate inside runner-pool commands.

### 4.4 Drain runner sockets and finalization chains

- [ ] Split runner-pool shutdown into `beginShutdown()` and asynchronous `shutdown()`.
- [ ] Stop accepting upgrades, registrations, and assignments before capturing existing sockets.
- [ ] Close sockets with code 1001, then terminate only after a bounded handshake deadline.
- [ ] Await each socket's serialized event chain until its result/finalization and close recovery are
      stable.
- [ ] Clear the registry and close the WebSocket server only after those chains settle.
- [ ] Preserve existing result-wins/close-wins assignment fencing.

### 4.5 Make runner shutdown awaitable

- [ ] Return one cached promise from `runnerService.shutdown()`.
- [ ] Set stopped first, clear reconnect/heartbeat timers, abort the current process without
      emitting a competing result, close the socket, and await close.
- [ ] Terminate a stuck socket after the socket deadline.
- [ ] Use the same promise in monitor and runner-only modes; runner-only exits zero only after it
      settles.

### 4.6 Close persistence in strict order with a deadline

- [ ] After HTTP, queue, local runner, and runner-pool drains: await `db.close()`, then await
      `mongoService.stop()`.
- [ ] Continue later cleanup after an earlier teardown error and exit nonzero after cleanup.
- [ ] On the global deadline, log active request/socket/queue counts, force-close transports, and
      exit nonzero exactly once.
- [ ] Never close the database underneath JavaScript handlers still known to be running.
- [ ] Route HTTP bind, queue fatal, and mongod fatal failures through the coordinator once resources
      have started.

### 4.7 Align deployment shutdown behavior

- [ ] Add centralized shutdown/socket deadline constants.
- [ ] Add a longer matching `stop_grace_period` to monitor and runner services in `compose.yaml`.
- [ ] Document equivalent `docker run --stop-timeout` values in `README.md`.
- [ ] Correct the architecture documentation to match the actual drain order.

### 4.8 Add shutdown tests

- [ ] Add `backend/tests/shutdown.test.js` for ordering, idempotence, partial startup, repeated
      signals, errors, and deadline expiry.
- [ ] Use a real ephemeral HTTP server with one deferred handler to prove new requests stop while
      admitted work drains.
- [ ] Add queue tests for shutdown at lookup, claim, prepare, validate, and assignment boundaries.
- [ ] Add runner-pool tests proving registry clearing waits for result/finalization and close
      recovery chains.
- [ ] Add runner-only subprocess coverage for signal handling and no monitor subsystem startup.

## Blocker 4 acceptance gate

- [ ] No HTTP request, WebSocket registration, queue claim, or runner assignment starts after the
      acceptance barrier.
- [ ] DB close never begins before active request/finalization/recovery work settles.
- [ ] Every repeated signal runs each teardown action exactly once.
- [ ] A forced deadline exits nonzero and leaves startup recovery enough durable evidence to
      reconcile interrupted work.

---

# Blocker 5 — Operational gaps

> **Status:** Integrated on `production-hardening-integration`; combined verification and independent review passed.

## Current state

- ffprobe has no wall-clock timeout (`backend/services/probe.js:59`).
- The local runner stops scheduling reconnects after the give-up window despite being configured
  not to exit (`backend/services/runner.js:70`).
- Readiness omits processing capacity (`backend/services/readiness.js:4`).
- Frontend fetches have no timeout or caller cancellation (`frontend/src/api/client.js:33`).
- Dashboard errors are tracked but not consumed by the page, while action failures only reach the
  console (`frontend/src/hooks/dashboard.js:17`, `frontend/src/app/dashboard/page.js:53`).
- Settings and auth loads lack cancellation/last-request-wins protection
  (`frontend/src/hooks/settings.js:31`, `frontend/src/hooks/auth.js:29`).

## Plan

### 5.1 Bound ffprobe execution

- [ ] Add a centralized ffprobe timeout constant.
- [ ] Extract an injectable `probeMedia()` helper using `execFile` with timeout and `SIGKILL`.
- [ ] Convert timeout into a stable persisted diagnostic while preserving spawn, output-buffer,
      JSON, and normal ffprobe errors.
- [ ] Keep probe-generation ownership checks before publishing success or failure.
- [ ] Test a real hanging fixture and assert its PID no longer exists after timeout.

### 5.2 Keep the local runner reconnecting

- [ ] Extract a pure reconnect decision: remote runners exit after the configured window; the
      in-process runner retries forever with capped backoff.
- [ ] Log local extended outage warnings at a bounded rate rather than every attempt.
- [ ] Reset attempt/window state only after a successful connection.
- [ ] Add deterministic before/at/after-window tests without waiting in real time.

### 5.3 Add processing-capacity readiness

- [ ] Add a `processing` readiness subsystem sourced from runner registry state.
- [ ] Report connected, idle, busy, paused, and accepting counts.
- [ ] Define ready as at least one live registered runner; busy or paused runners still count as
      connected capacity so normal load does not flap readiness.
- [ ] Publish capacity after register, remove, assignment, idle, pause, watchdog eviction, clear,
      and shutdown.
- [ ] Return `processing: no_runners` when capacity disappears and `stopped` during shutdown.
- [ ] Extend health and runner-pool tests for every capacity transition.

### 5.4 Add a bounded, cancellable frontend request primitive

- [ ] Add a centralized frontend request timeout.
- [ ] Extend API client requests with caller `signal` and optional `timeoutMs`.
- [ ] Use an internal `AbortController` that covers both `fetch` and response parsing and always
      clears timers/listeners.
- [ ] Distinguish `timeout` from caller `cancelled` in `API_ERROR_KIND`.
- [ ] Capture the bearer used by each request; an obsolete 401 must not clear a newer session.
- [ ] Thread request options through every API wrapper without breaking existing callers.
- [ ] Never automatically retry mutations after timeout because server completion is ambiguous.

### 5.5 Add cancellation and last-request-wins hooks

- [ ] Add `frontend/src/lib/latest-request.js`, using AbortController plus a monotonically
      increasing generation.
- [ ] Make settings load/Retry last-request-wins and abort on unmount; keep mutation writes in their
      existing serialized queue.
- [ ] After ambiguous mutation failure, reload authoritative state before allowing a retry.
- [ ] Coordinate auth hydrate, Retry, login, logout, and unauthorized invalidation so a late result
      cannot restore a logged-out/obsolete session.
- [ ] Abort dashboard batches on filter change/unmount while retaining single-flight,
      completion-based polling.

### 5.6 Surface retryable operational failures

- [ ] Consume dashboard `loading`, `error`, and `stale` state in the dashboard page.
- [ ] Show an initial loading state, initial failure with Retry, and stale-data warning that keeps
      the last successful snapshot visible.
- [ ] Replace console-only action failure with localized action-specific error and explicit Retry.
- [ ] Route processing and worker pause actions through the same busy/error path.
- [ ] Surface settings scan failures and ambiguous timeout guidance.
- [ ] Add all display strings in English and Spanish in `frontend/src/lib/strings.js`; do not
      hardcode UI text.

### 5.7 Add frontend and operational tests

- [ ] Add pure client tests for timeout, cancellation, cleanup, and obsolete-401 handling.
- [ ] Add latest-request tests where slow first and fast second responses finish in both orders.
- [ ] Add browser tests for dashboard initial failure, stale polling, action failure/Retry, rapid
      filter navigation, settings Retry, auth transport recovery, and both languages.
- [ ] Use mocked `/api/*` envelopes so browser races are deterministic and require no Mongo/ffmpeg
      fixture.

## Blocker 5 acceptance gate

- [ ] A hung ffprobe process is forcibly gone within the configured bound and the queue advances.
- [ ] The monitor-local runner reconnects after an outage longer than the remote give-up window.
- [ ] Health becomes unavailable when no processing capacity remains and recovers on registration.
- [ ] No frontend request can wait forever or let an obsolete response overwrite current state.
- [ ] Operators see actionable localized error and Retry states for dashboard, action, settings,
      and auth failures.

---

# Combined verification and release gate

## Latest integrated result

The reviewed integration branch passed:

- focused backend lifecycle/shutdown/runner/readiness/regex tests: 139/139;
- full backend tests: 183/183, three sequential runs;
- frontend tests: 29/29, three sequential full-suite runs;
- safe-regex suite: 20 additional consecutive runs;
- frontend and backend lint;
- Prettier formatting check;
- Next.js static production build;
- shell syntax, committed-diff, conflict-marker, privacy, and offline dependency-audit checks.

The deferred Blocker 3 commit is not in the integration history. Docker/Compose, live Mongo/container shutdown, representative media-volume, and real-browser smoke tests remain unavailable and must not be reported as passed.

Run these after every blocker and again after all four are integrated:

1. `git diff --check`
2. Focused backend tests for the blocker being implemented.
3. `npm test`
4. `npm run lint`
5. `npm run format:check`
6. `npm run build`
7. Frontend unit and browser tests added by blocker 5.
8. Crash/restart replay for every mutation and overwrite journal checkpoint.
9. Monitor shutdown while an HTTP mutation, inline probe, transcode preparation, runner result, and
   runner-loss recovery are each held at a deterministic boundary.
10. Monitor restart after every pre-commit and committed destructive-operation phase.
11. Two-runner smoke test: dispatch, stop, requeue, disconnect, reconnect, and restart without job
    resurrection or duplicate ownership.
12. Container smoke test for SIGTERM drain and post-restart recovery when container tooling is
    available.
13. Confirm there are no orphan ffprobe/ffmpeg processes or untracked scratch/backup/tombstone
    files after success, failure, timeout, cancellation, and restart.
14. Confirm `git status --short` contains only the intended source, test, and documentation changes.

## Risk ledger

- **In-process guarantees require one monitor.** Multiple monitor processes remain unsupported and
  out of scope.
- **Document serialization is not a filesystem/database transaction.** Durable journals remain the
  authority for cross-resource recovery.
- **Hard links may be unsupported by some mounts.** Abort before destructive work on `EXDEV`,
  `EPERM`, or unsupported-link errors; do not fall back to clobbering rename.
- **External writers retain a small TOCTOU window.** Recheck identity immediately before every
  unlink/install and abort on any ambiguity.
- **Shutdown cannot preempt JavaScript safely.** The deadline must force process exit rather than
  close persistence beneath known active handlers.
- **Frontend mutation timeout is ambiguous.** Refresh authoritative state and require explicit user
  retry; never auto-replay.
- **Readiness semantics must not flap under load.** Connected busy/paused runners count as capacity;
  only zero live runners is unavailable.
- **This scope excludes blocker 1 and blocker 6.** A production release remains blocked until runner
  transport/trust is secured and the complete container/volume matrix passes.
