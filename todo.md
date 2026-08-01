# Squeezarr correctness and reliability TODO

This backlog records source-level findings from a full review of the monitor, queue, transcoding
pipeline, runner protocol, API, frontend, database layer, and deployment files. Items are ordered by
risk and dependency rather than implementation size.

Priority meanings:

- **P0:** credible data-loss, media-corruption, or state-corruption path; address before expanding use.
- **P1:** broken lifecycle or operational behavior that can strand work or make the service unreliable.
- **P2:** user-visible correctness, session, validation, or recoverability issue.
- **P3:** narrower edge case or missing UI capability with a straightforward workaround.

Suggested order: establish task/file ownership first (P0-02), then use it to fix output reservation,
finalization, stop, disconnect, crash recovery, and stale-runner fencing. Avoid independently patching
status fields in ways that create another competing state machine.

Implementation progress:

- **21 of 22 findings are implemented** and covered by the repository verification suite.
- **P1-08 is partially implemented:** `/config` now uses a named-volume default and development matches
  the production runtime user; the cross-runtime container/volume smoke-test matrix remains outstanding.
- Nested checkboxes remain as the detailed acceptance and environment-validation backlog.

---

## P0-01 — Reserve output paths before allowing ffmpeg to overwrite them

- [x] Prevent generated output paths from overwriting unrelated source files or outputs.

**Confidence:** High

**Relevant code:**

- `backend/services/ffmpeg/prepare.js` (`buildOutputPath`, `prepareTranscode`)
- `backend/services/scanner.js` (known-output cleanup)
- `backend/utilities/scanpath.js`

**Problem:** Adjacent output names are derived only from the source basename, prefix, suffix, and
extension. Preparation rejects only the exact input path, then invokes ffmpeg with `-y`. It does not
check whether the destination already exists, belongs to another scanned source, is an output owned
by another file/setting, or is currently being written. For example, transcoding `movie.mkv` to the
default `movie.hevc.mkv` can destroy a pre-existing, independently owned `movie.hevc.mkv`. Once that
path is recorded as an output, the scanner can also remove the destroyed file's database document as
a stray output, concealing the collision.

**Implementation tasks:**

- [ ] Define canonical ownership for every source, active output, and completed output path.
- [ ] Add an output reservation step before changing the file to `processing` or dispatching a task.
- [ ] Reject a path owned by another source, job, file, or setting with an actionable failed result.
- [ ] Permit replacement only when the destination is provably owned by the same file/setting and the
      operation explicitly supports regeneration.
- [ ] Stop using `-y` as the collision policy; use it only after the reservation proves ownership.
- [ ] Give overwrite-mode temporary files collision-resistant, job-owned names instead of a basename-only
      `.transcodetmp` name.
- [ ] Ensure reservations are released on every success, rejection, failure, cancellation, disconnect,
      shutdown, and startup-recovery path.

**Regression tests:**

- [ ] Create real `movie.mkv` and `movie.hevc.mkv` sources, prepare the default HEVC transcode, and
      assert that preparation fails without modifying either file or deleting either document.
- [ ] Cover two settings and two source paths that resolve to the same adjacent destination.
- [ ] Cover stale owned output regeneration separately from an unowned collision.
- [ ] Cover overwrite temporary-path collisions between same-stem sources.

**Acceptance criteria:** No ffmpeg task can receive an existing destination unless Squeezarr has a
current, durable ownership record authorizing that exact task to replace it.

---

## P0-02 — Enforce one active transcode per file and persist job ownership

- [x] Prevent multiple matching profiles from processing one file concurrently.

**Confidence:** High

**Relevant code:**

- `backend/services/probe.js` (one job per matching setting)
- `backend/services/event/dispatch.js` (`dispatchTranscodes`)
- `backend/services/ffmpeg/prepare.js`
- `backend/services/ffmpeg/finalize.js`
- `backend/services/runnerpool/registry.js`
- `backend/tests/dispatch.test.js`

**Problem:** Probe intentionally enqueues one transcode job per matching profile, but dispatch limits
only total runner capacity. Two jobs with the same `fileId` can be claimed in one pass and assigned to
different runners. Preparation does not reject a file already in `processing`; each preparation
overwrites the file's single `currentOutputPath`. Finalization then reconstructs task state from that
shared pointer. One result can therefore filter, delete, rename, or record another runner's partial
output. Two overwrite jobs may write the same temporary path at the same time.

**Implementation tasks:**

- [ ] Add a durable active-task owner to the file or job state, including `jobId`, `settingId`, and
      prepared output path.
- [ ] Make the transition into processing conditional on the file having no active owner.
- [ ] During each dispatch pass, exclude duplicate `fileId` values already active or already selected
      earlier in the same pass.
- [ ] Leave sibling profile jobs pending until the owning job reaches a durable terminal state.
- [ ] Finalize, cancel, reset, and recover only when the supplied job still owns the file.
- [ ] Persist task-specific output paths rather than relying on one unqualified file-level pointer.
- [ ] Preserve profile priority order when releasing the next job for a file.
- [ ] Make stale or duplicate results harmless through an ownership/version check.

**Regression tests:**

- [ ] Dispatch two pending jobs with the same `fileId` and capacity for two; assert that only the
      highest-priority job is assigned.
- [ ] Complete the first job and assert that the second becomes eligible exactly once.
- [ ] Submit a result from a stale/non-owning task and assert that it cannot mutate file, job, or disk.
- [ ] Cover adjacent/adjacent, adjacent/overwrite, and overwrite/overwrite profile combinations.

**Acceptance criteria:** A file has at most one active transcode owner, and every destructive or
terminal transition proves that the caller still owns the same task generation.

---

## P0-03 — Make overwrite replacement crash-safe

- [x] Eliminate the unrecoverable window between replacing the source and persisting success.

**Confidence:** High

**Relevant code:**

- `backend/services/ffmpeg/finalize.js` (`finalizeSuccess`)
- `backend/services/processing.js` (`recoverStuckFiles`)
- `backend/services/event/recovery.js`
- `backend/server.js` (startup ordering)

**Problem:** Overwrite finalization renames the temporary output over the source before several
awaited database writes record the result, release cancellation, and set `replaced`. A crash or
database failure after the rename leaves transcoded bytes installed as the source while persistence
still says `processing`. Startup recovery treats that as an interrupted transcode, clears the missing
temporary path, resets the file to pending, and fails the old job. The already-transcoded media may
then be transcoded again, causing generational quality loss with no record of the original replace.

**Implementation tasks:**

- [ ] Design a durable overwrite journal with explicit prepared, replacing, committed, and cleaned
      phases tied to the owning job.
- [ ] Retain a recoverable backup or use an equivalent transaction protocol until the database commit
      is durable.
- [ ] Record enough metadata to distinguish “rename never happened” from “source already replaced.”
- [ ] Reconcile journal and filesystem state on startup before normal stuck-file/job recovery.
- [ ] Make recovery idempotent across repeated crashes during each phase.
- [ ] Define how to handle a database failure after filesystem replacement without silently requeueing
      the modified source.
- [ ] Remove the journal/backup only after both file and job terminal state are durable.

**Regression tests:**

- [ ] Inject a process failure after each await surrounding rename, result upsert, cancellation release,
      status update, and job completion.
- [ ] Restart recovery after every injected point and assert exactly one replacement result.
- [ ] Assert that recovery never schedules another lossy transcode of already-replaced bytes.
- [ ] Verify both rollback and roll-forward behavior while temporary and backup files exist.

**Acceptance criteria:** Every crash point yields either the untouched original or one durably recorded
replacement; it must never yield an unrecorded replacement that is automatically transcoded again.

---

## P0-04 — Serialize runner results with socket close and reconnect recovery

- [x] Make result handling and runner-loss recovery exactly-once and order-independent.

**Confidence:** High

**Relevant code:**

- `backend/services/runnerpool/server.js`
- `backend/services/runnerpool/inbound.js`
- `backend/services/runnerpool/recovery.js`
- `backend/services/job.js`

**Problem:** WebSocket `message` and `close` callbacks launch independent asynchronous handlers. A
runner can send its final result and disconnect while finalization is still awaiting filesystem or
database work. The close path sees the runner as busy, removes it, deletes/reset its output state, and
patches the job back to pending. The result path can then continue with stale state. Conversely, a
successful finalization can be followed by an unconditional recovery patch. This can delete valid
output, rerun completed work, or leave a finalized file attached to a pending job.

**Implementation tasks:**

- [ ] Serialize inbound messages and close handling per socket or per task assignment.
- [ ] Transition the assignment to a durable `finalizing`/completing state before awaiting finalization.
- [ ] Make disconnect recovery conditional on the same socket/task still owning a running assignment.
- [ ] Make job complete, fail, and requeue conditional transitions rather than unconditional patches.
- [ ] Validate that every result comes from the socket currently assigned that `taskId`.
- [ ] Ignore stale results from replaced connections without marking a new assignment idle.
- [ ] Ensure reconnect reclamation and old-socket close cannot both recover the same task.

**Regression tests:**

- [ ] Delay finalization, deliver a result, close the socket, then release finalization; assert one
      terminal transition and no requeue.
- [ ] Run the inverse close-before-result ordering and assert the late result is fenced out.
- [ ] Reconnect the same runner ID before the old socket closes and verify the new registration survives.
- [ ] Verify a terminal job is never patched back to pending by disconnect recovery.

**Acceptance criteria:** Result, close, and reconnect events in any ordering produce one authoritative
outcome and never delete or rerun already-committed work.

---

## P0-05 — Make stop and finalization a single conditional state machine

- [x] Prevent an acknowledged stop from losing to stale finalization.

**Confidence:** High

**Relevant code:**

- `backend/controllers/files/mutations.js` (`stop`)
- `backend/services/processing.js`
- `backend/services/ffmpeg/finalize.js`
- `backend/database/facade.js`

**Problem:** Finalization reads the file once and later checks that stale snapshot before running
potentially slow filters and accepting the output. Stop independently writes `stopped` and then
`cancelled`. If stop arrives after finalization's first read, success can still rename an overwrite
output over the source, clear cancellation, and set `transcoded`/`replaced` after the API has reported
`file_stopped`. The current read-modify-replace facade offers no conditional ownership/version guard.

**Implementation tasks:**

- [ ] Define explicit allowed transitions for active, stopping, finalizing, stopped, and terminal states.
- [ ] Make stop atomically set cancellation and transition only the current task generation.
- [ ] Make final success conditional on the same owner/version still being active and not cancelled.
- [ ] Re-check/claim immediately before filters that have side effects and again before overwrite rename.
- [ ] Define deterministic semantics when a stop arrives after irreversible commit has begun: either
      reject stop as too late or guarantee stop wins before commit; never report an ambiguous success.
- [ ] Ensure cleanup clears transient fields without overwriting a newer task generation.

**Regression tests:**

- [ ] Block a filter after the initial finalization read, call stop, release the filter, and assert the
      output is discarded and status remains stopped.
- [ ] Repeat for overwrite mode and assert the source is not renamed after acknowledged stop.
- [ ] Test both interleavings around the final conditional commit.
- [ ] Assert status, result list, cancellation, output path, and job state remain mutually consistent.

**Acceptance criteria:** Once stop returns success, no later work from that task can accept an output or
replace the source.

---

## P1-01 — Supervise mongod and the queue loop, and report real readiness

- [x] Prevent the monitor from remaining healthy-looking after its database or queue dies.

**Confidence:** High

**Relevant code:**

- `backend/services/mongo.js`
- `backend/services/event.js`
- `backend/routes/index.js` (`/api/health`)
- `Containerfile` (`HEALTHCHECK`)

**Problem:** An unexpected mongod exit only clears the child reference and logs. An uncaught rejection
in top-level queue operations ends `processLoop`; the catch only logs while `running` remains true, so
`initialize()` cannot restart it. `/api/health` always reports success and the container healthcheck
only calls that route. Persistence and all queued work can therefore remain dead indefinitely while
the process and container report healthy.

**Implementation tasks:**

- [ ] Distinguish intentional mongod shutdown from unexpected child exit.
- [ ] Choose one policy: exit the monitor nonzero and rely on the restart policy, or implement bounded,
      observable mongod/Mongoose/queue supervision.
- [ ] Clear/update queue lifecycle state when the loop exits unexpectedly.
- [ ] Add bounded retries only for errors known to be transient; fail the process on unrecoverable state.
- [ ] Track readiness for mongod child state, Mongoose connection state, queue-loop state, and HTTP state.
- [ ] Make health return non-2xx when required monitor subsystems are unavailable.
- [ ] Keep runner-only health semantics separate because runner containers do not expose HTTP.

**Regression tests:**

- [ ] Terminate mongod after readiness and assert restart/recovery or a nonzero monitor exit.
- [ ] Force `relayCancellations`, settings lookup, and pending-job listing to reject at loop top level.
- [ ] Assert health becomes non-2xx while Mongo or the queue is down and returns only after recovery.
- [ ] Verify intentional shutdown does not trigger a false crash restart path.

**Acceptance criteria:** A monitor unable to persist or process work cannot continue reporting healthy.

---

## P1-02 — Require a real output and recover file state when finalization fails

- [x] Stop reporting success for missing outputs and stop leaving failed finalizations in `processing`.

**Confidence:** High

**Relevant code:**

- `backend/services/filters.js`
- `backend/services/ffmpeg/finalize.js`
- `backend/services/runnerpool/inbound.js`

**Problem:** Filter filesystem errors, including a missing output, are logged and treated as acceptance.
Adjacent success converts failed `stat` into size zero and still records a successful transcode. In
overwrite mode, a missing/unrenameable output throws; the result handler fails only the job, leaving
the file's processing status, output path, and timestamps intact. A mismapped shared volume or external
file removal can therefore create false success or a permanently stuck file.

**Implementation tasks:**

- [ ] Require the expected output to exist, be a regular file, and be readable before filters or success.
- [ ] Treat output validation failure as a transcode/finalization failure with an actionable message.
- [ ] Decide which filter errors are rejection, failure, or retryable infrastructure errors; do not
      silently convert unknown filter errors to acceptance.
- [ ] Wrap finalization in a recovery path that clears task-owned transient fields and cancellation.
- [ ] Move the file to a deliberate failed or retryable state whenever job finalization fails.
- [ ] Preserve an output reservation/ownership record if cleanup itself fails.

**Regression tests:**

- [ ] Report exit code zero with an absent adjacent output and assert failure, not zero-byte success.
- [ ] Reject `stat`, filter reads, and overwrite rename separately and verify consistent file/job state.
- [ ] Test an output that exists but is a directory, symlink if disallowed, or unreadable file.
- [ ] Assert no path leaves the file in `processing` after the job becomes failed.

**Acceptance criteria:** Successful results always point to a verified output, and every finalization
exception leaves the file in a recoverable, non-processing state.

---

## P1-03 — Derive multi-profile file status from all work and results

- [x] Fix profile rejection/failure ordering so successful outputs are not skipped or hidden.

**Confidence:** High

**Relevant code:**

- `backend/services/ffmpeg/finalize.js`
- `backend/services/ffmpeg/prepare.js`
- `backend/services/scanner.js` (`reconcileQueuedFiles`)
- `backend/controllers/files/list.js`

**Problem:** File status is overwritten by each individual profile result. A first rejection sets the
file to terminal `rejected`, causing later queued profiles to be skipped. A failure after an earlier
success sets the whole file to `failed`. A rejection after success sets the file to `queued`; scanner
reconciliation sees every setting already attempted and enqueues nothing, so the file can remain
queued forever even though it has a usable output. The UI then hides it from the Done bucket.

**Implementation tasks:**

- [ ] Model per-profile job/result state separately from aggregate file state.
- [ ] Include pending/running profile jobs when deriving whether the file is still active.
- [ ] Define final precedence: a usable output should remain actionable even if another profile fails
      or rejects; failed/rejected should describe the file only when no usable output exists.
- [ ] Ensure a rejection cannot make remaining valid profile jobs terminally ineligible.
- [ ] Recompute aggregate status after every profile terminal event using one shared function.
- [ ] Keep list buckets, statistics, requeueability, and UI actions aligned with the aggregate rule.

**Regression tests:**

- [ ] Cover rejection→success, success→rejection, failure→success, and success→failure.
- [ ] Cover all-rejected, all-failed, and mixed rejected/failed with no successful output.
- [ ] Cover a third profile still pending while the first two finish.
- [ ] Assert no fully attempted file remains `queued` without pending/running work.

**Acceptance criteria:** Profile completion order cannot change the final aggregate meaning, skip valid
work, or hide an existing usable output.

---

## P1-04 — Reset cancellation and reconcile stale jobs during requeue

- [x] Make a stopped file successfully restart on its first requeue.

**Confidence:** High

**Relevant code:**

- `backend/controllers/files/mutations.js` (`stop`, `requeue`)
- `backend/services/processing.js`
- `backend/services/runnerpool/commands.js`
- `backend/services/job.js`

**Problem:** Stopping pending/queued files sets durable `cancelled=true`, but there is no running
finalizer to release it. Requeue sets status and results but leaves cancellation and transient
processing fields untouched. The next assignment sees the retained flag and is immediately cancelled.
Old pending transcode jobs can also survive a stop/requeue and race the newly enqueued probe path.

**Implementation tasks:**

- [ ] Make requeue a single clean lifecycle transition that clears `cancelled`, `currentOutputPath`,
      `processingStartedAt`, and any active owner for the old generation.
- [ ] Find and cancel/fail/remove obsolete pending/running jobs for that file before enqueueing a probe.
- [ ] Introduce a generation/version so a late result or stop from the old attempt cannot affect the
      requeued attempt.
- [ ] Coordinate requeue requested immediately after stopping a running task; do not start new work
      until old execution/finalization is fenced or settled.
- [ ] Return a clear error if safe requeue cannot yet be established.

**Regression tests:**

- [ ] Stop and requeue pending and queued files; assert the first retry is not cancelled.
- [ ] Stop a running file and immediately requeue; deliver a late old result and assert it is ignored.
- [ ] Verify obsolete transcode jobs do not run ahead of or duplicate the new probe-generated jobs.

**Acceptance criteria:** Requeue creates one clean task generation with no retained cancellation or
stale job capable of affecting it.

---

## P1-05 — Enforce runner heartbeat expiry and fence reassigned work

- [x] Recover from frozen runners and half-open WebSocket connections within a bounded time.

**Confidence:** High

**Relevant code:**

- `backend/services/runner/metrics.js`
- `backend/services/runnerpool/inbound.js`
- `backend/services/runnerpool/registry.js`
- `backend/services/runnerpool/server.js`
- `backend/utilities/constants.js`

**Problem:** Runners send heartbeats and the monitor records `lastHeartbeatAt`, but nothing checks its
age. Recovery runs only after WebSocket close. A frozen process, network blackhole, or half-open TCP
connection can keep a runner, job, and file busy indefinitely. Reassigning work after a future timeout
also risks two ffmpeg processes writing when the old runner continues during a partition.

**Implementation tasks:**

- [ ] Add WebSocket ping/pong and/or a monitor watchdog with a documented heartbeat deadline.
- [ ] Terminate stale sockets so the normal close path can recover work exactly once.
- [ ] Start/stop the watchdog with runner-pool lifecycle and avoid timer leaks during reload/shutdown.
- [ ] Fence every assignment with a generation/lease checked when results arrive.
- [ ] Use unique task-owned output paths so an unfenced old executor cannot corrupt a new attempt.
- [ ] Expose stale/last-seen state in runner diagnostics before eviction where useful.

**Regression tests:**

- [ ] Register a busy fake runner, stop heartbeats while keeping the socket open, and advance a fake
      clock past the deadline.
- [ ] Assert termination and recovery happen once, while timely heartbeats prevent eviction.
- [ ] Resume an old partitioned runner after reassignment and assert its stale result cannot finalize.

**Acceptance criteria:** Runner loss is detected within a configured bound and stale execution cannot
mutate a reassigned task.

---

## P1-06 — Preserve output ownership when deletion fails

- [x] Stop forgetting output paths when the file could not actually be removed.

**Confidence:** High

**Relevant code:**

- `backend/controllers/files/mutations.js` (`remove`, `deleteOutput`, `requeue`)
- `backend/utilities/scanpath.js`

**Problem:** Output deletion paths suppress every `unlink` error and then clear the result or entire
file document. `ENOENT` is safe to treat as already deleted, but `EACCES`, `EBUSY`, read-only mounts,
and other errors leave the output on disk while removing the only ownership record. The next scan can
then ingest that output as a new source and create chained transcodes.

**Implementation tasks:**

- [ ] Centralize output deletion with explicit `ENOENT` handling and propagated non-ENOENT failures.
- [ ] Preserve `outputPath`/result ownership whenever deletion does not succeed.
- [ ] Return a failed API envelope with an actionable error rather than reporting deletion/requeue success.
- [ ] Decide whether source deletion may proceed when one of its owned outputs cannot be removed; if it
      does, retain a tombstone/exclusion record until cleanup succeeds.
- [ ] Add a retryable cleanup path for outputs that remain owned but failed deletion.

**Regression tests:**

- [ ] Inject `ENOENT` and assert tracking is safely cleared.
- [ ] Inject `EACCES`, `EBUSY`, and read-only filesystem errors and assert tracking remains.
- [ ] Run known-output collection after failed cleanup and assert scanner still excludes the path.

**Acceptance criteria:** A surviving output is never forgotten merely because its deletion failed.

---

## P1-07 — Guarantee exactly one runner result per task

- [x] Make runner child-process completion idempotent across `error`, `close`, cancel, and abort.

**Confidence:** High; a missing executable currently emits both an ENOENT result and a second close
result for the same task.

**Relevant code:**

- `backend/services/runner/task.js`
- `backend/services/runner.js`
- `backend/services/runnerpool/inbound.js`
- `backend/tests/runner.test.js`

**Problem:** `task.js` sends independently from child `error` and `close` handlers without a settled
guard. Node emits both for spawn failures, producing duplicate results and competing finalization.
`abortCurrent()` clears global state and kills the process, but its later close callback still executes;
the closed socket currently drops that send, yet the task lifecycle contract is still incorrect and
fragile. Global `current` access can also make an old close callback inspect or clear state belonging to
a newer task if lifecycle ordering changes.

**Implementation tasks:**

- [ ] Create a task-local, idempotent `finish()` guarded by `settled` and route all outcomes through it.
- [ ] Capture cancellation and stderr on the task object rather than reading mutable global state in a
      later callback.
- [ ] Detach/ignore listeners on abort and explicitly suppress result emission for connection-loss abort.
- [ ] Clear global `current` only if it still refers to the same task object.
- [ ] Add monitor-side conditional result claiming as defense in depth.

**Regression tests:**

- [ ] Spawn a guaranteed-missing executable and assert exactly one ENOENT result.
- [ ] Cover normal success, normal nonzero exit, user cancellation, spawn permission failure, and
      socket-loss abort; each should produce the documented number and type of results.
- [ ] Start a new task after aborting the old one and assert late callbacks cannot clear the new task.

**Acceptance criteria:** Every assignment settles at most once, and callbacks from an older task cannot
alter a newer task.

---

## P1-08 — Make clean production installs work with common volume ownership layouts

- [ ] Ensure the non-root image can initialize `/config` and write intended outputs.

**Confidence:** Medium until validated across supported Docker/Podman rootful and rootless modes.

**Relevant code:**

- `Containerfile` (`USER node`, uid 1000)
- `Containerfile.local`
- `README.md` installation examples
- `compose.yaml`
- `backend/services/mongo.js`

**Problem:** The production image runs as uid 1000. Image-layer ownership of `/config` and `/data` is
hidden by bind mounts. Short bind syntax can create missing host directories with ownership that uid
1000 cannot write, and the monitor immediately needs to create `/config/mongodb`. The local development
image runs as root and can also leave state that the production user cannot reuse. Media writes/renames
fail when the shared library is readable but not writable by the production user.

**Implementation tasks:**

- [ ] Reproduce the exact documented clean install on rootful Docker, rootless Docker, and rootless
      Podman where supported.
- [ ] Choose a zero-surprise default, preferably a named volume for `/config`.
- [ ] Document explicit bind-mount ownership/ACL requirements for users who choose bind mounts.
- [ ] If automatic initialization is required, add a minimal root entrypoint that fixes only safe
      config ownership and drops privileges; do not recursively chown a large media library.
- [ ] Align development-image ownership or document migration of root-created state.
- [ ] Verify runner-only containers need write access to shared `/data` but no persistent `/config`.

**Regression tests:**

- [ ] Start from no config directory, confirm Mongo becomes ready, recreate the container, and verify
      state persistence.
- [ ] Reuse state created by the local image under the production image.
- [ ] Perform an adjacent write and overwrite rename against a representative shared media mount.

**Acceptance criteria:** A documented fresh installation starts without manual recovery, and permission
requirements for bind-mounted media are explicit and tested.

---

## P1-09 — Replace unsafe synchronous user regex matching

- [x] Prevent accepted match patterns from blocking the monitor event loop.

**Confidence:** High

**Relevant code:**

- `backend/services/settings-validation.js`
- `backend/services/probe.js` (`matchesPattern`)
- `backend/tests/settings-validation.test.js`

**Problem:** Validation limits regex length and checks compilation, but short expressions such as nested
quantifiers can cause catastrophic backtracking. Probe evaluates the user pattern synchronously for
every candidate path in the single monitor process. A pathological but accepted pattern can block API,
WebSocket, cancellation, and queue work for seconds or longer per file.

**Implementation tasks:**

- [ ] Prefer a safe matching language such as glob/substring if full JavaScript regex is unnecessary.
- [ ] Otherwise use a non-backtracking engine or execute matching in an isolated worker with a hard
      timeout and bounded resource policy.
- [ ] Do not rely only on length or a simplistic nested-quantifier blacklist.
- [ ] Return a clear validation error for unsupported/unsafe constructs.
- [ ] Document the accepted syntax in the settings UI.

**Regression tests:**

- [ ] Add adversarial patterns and filenames with a strict bounded-time assertion.
- [ ] Preserve valid patterns currently used by profiles.
- [ ] Verify one bad pattern cannot prevent other settings/files from being evaluated.

**Acceptance criteria:** No accepted path filter can monopolize the monitor event loop for unbounded time.

---

## P1-10 — Replace whole-document settings races with narrow, versioned mutations

- [x] Prevent pause and profile updates from silently overwriting each other.

**Confidence:** High

**Relevant code:**

- `backend/controllers/actions.js`
- `backend/controllers/settings.js`
- `backend/services/settings.js`
- `backend/database/facade.js`
- `frontend/src/hooks/settings.js`
- `frontend/src/app/settings/page.js`
- `frontend/src/components/settings/settingcard.js`
- `frontend/src/components/settings/settingform.js`

**Problem:** Pause and general settings both read and replace the singleton document. The frontend keeps
`processingPaused` separately, so toggling pause does not update the settings object later sent by
Save. Saving an unrelated field can silently undo pause while the UI continues showing paused. Rapid
profile toggles/deletes also issue concurrent whole-document PUTs derived from the same render snapshot;
the last response wins and can erase an accepted change. Failed optimistic pause calls are not rolled
back.

**Implementation tasks:**

- [ ] Remove `processingPaused` from the general settings replacement contract or update it only through
      a narrow atomic operation.
- [ ] Add document revision/compare-and-swap semantics or resource-specific mutation endpoints for
      profiles, extensions, and schedule.
- [ ] Serialize frontend settings mutations and derive each from the latest committed/optimistic state.
- [ ] Disable every mutation control while a conflicting save is active, or queue the mutation safely.
- [ ] Update displayed and editable pause state from the successful server response.
- [ ] Roll back optimistic state and show an actionable error on failed pause/profile requests.

**Regression tests:**

- [ ] Pause, then save unrelated settings from a stale snapshot; assert pause remains active.
- [ ] Resolve two profile toggles/deletes in both response orders and assert both accepted changes remain.
- [ ] Test stale revision rejection and client refresh/retry behavior.
- [ ] Test a failed pause request and assert the UI returns to authoritative server state.

**Acceptance criteria:** Independent settings actions compose safely; no successful request silently
reverts another successful request.

---

## P2-01 — Preserve logout revocation across monitor restarts

- [x] Ensure a logged-out bearer token cannot become valid again after restart.

**Confidence:** High

**Relevant code:**

- `backend/services/auth.js`
- `backend/controllers/auth.js`
- `backend/tests/auth.test.js`

**Problem:** Session tokens are self-contained and signed with the stable admin password. Logout stores
the token only in a module-local revocation map. Restart clears that map while retaining the signing
key, so an explicitly logged-out token becomes valid again until its 12-hour expiry.

**Implementation tasks:**

- [ ] Choose a session model: persist token/session IDs and expiry in Mongo, persist revocations, or
      rotate a startup/session epoch and intentionally invalidate all sessions on restart.
- [ ] Include a stable session identifier in tokens rather than persisting whole bearer values where
      possible.
- [ ] Prune expired session/revocation records safely.
- [ ] Keep logout idempotent without allowing a revoked token to reappear.

**Regression tests:**

- [ ] Log in, log out, recreate the auth service/process with the same password, and assert the old
      token remains unauthorized.
- [ ] Cover expiry pruning and password/session-epoch rotation.

**Acceptance criteria:** Restart cannot restore access for a token whose logout was acknowledged.

---

## P2-02 — Distinguish invalid sessions from temporary API failures during hydration

- [x] Stop deleting valid login tokens on transport, parse, or server errors.

**Confidence:** High

**Relevant code:**

- `frontend/src/api/client.js`
- `frontend/src/hooks/auth.js`
- `backend/routes/auth.js`

**Problem:** The API client collapses network, JSON, and HTTP failures into similar unsuccessful
envelopes. Auth hydration clears session storage for every unsuccessful session check, even though the
backend specifically uses 401 for invalid sessions. Reloading during a brief restart, dropped
connection, proxy error, or 500 permanently logs the user out despite a still-valid token.

**Implementation tasks:**

- [ ] Preserve HTTP status and a typed failure kind in the client result.
- [ ] Clear credentials only for an explicit 401/expired/revoked session response.
- [ ] Retain the token for retryable transport, parse, and 5xx failures.
- [ ] Add an auth “temporarily unavailable” state with retry rather than redirecting immediately.
- [ ] Ensure the global unauthorized handler still clears on genuine protected-route 401 responses.

**Regression tests:**

- [ ] Hydrate with a valid stored token, fail once with network error/500, then succeed; assert the token
      remains and authentication recovers.
- [ ] Verify a real 401 clears storage and redirects.
- [ ] Cover malformed JSON separately from authentication rejection.

**Acceptance criteria:** Temporary service failure cannot destroy a valid client session.

---

## P2-03 — Prevent fixed-interval polling from starving dashboard updates

- [x] Ensure slow requests eventually update the dashboard without unbounded overlap.

**Confidence:** High

**Relevant code:**

- `frontend/src/hooks/dashboard.js`
- `frontend/src/lib/constants.js`
- `backend/controllers/files/list.js`
- `backend/controllers/stats.js`

**Problem:** Every dashboard update increments a sequence and discards itself if any newer update has
started. `setInterval` starts another five-endpoint batch every five seconds regardless of whether the
previous batch finished. If batches consistently take longer than five seconds, each is invalidated by
the next before it resolves. The dashboard never updates while overlapping requests continue. This is
credible for large libraries because files and stats each load the complete files collection.

**Implementation tasks:**

- [ ] Switch to completion-based polling (`setTimeout` after completion) or skip ticks while a request
      batch is active.
- [ ] Abort genuinely obsolete requests when the status filter changes.
- [ ] Separate “newer filter generation” from ordinary periodic refresh so a later timer tick does not
      invalidate the only completed data.
- [ ] Consider a consolidated dashboard endpoint or database-side pagination/aggregation to reduce load.
- [ ] Expose loading/error/stale state rather than silently retaining defaults.

**Regression tests:**

- [ ] Use fake timers and requests slower than the poll interval; assert at most one periodic batch is
      active and the first completion renders.
- [ ] Change filters during a request and assert the old filter cannot overwrite the new one.
- [ ] Verify manual post-action refresh coexists with polling without starvation.

**Acceptance criteria:** Any eventually successful request batch can update the current view, and polling
never creates an unbounded chain of overlapping batches.

---

## P2-04 — Add explicit settings loading, error, and retry states

- [x] Replace the permanent loading screen after an initial settings request failure.

**Confidence:** High

**Relevant code:**

- `frontend/src/hooks/settings.js`
- `frontend/src/app/settings/page.js`
- `frontend/src/api/client.js`

**Problem:** Settings are fetched once. Any unsuccessful response becomes `null`, and the page uses
`null` to mean loading. A single transient GET failure leaves the page showing Loading forever with no
retry or error message, even after the backend recovers.

**Implementation tasks:**

- [ ] Track `loading`, `error`, and `settings` as distinct states.
- [ ] Render an actionable localized error and Retry control.
- [ ] Optionally add bounded automatic retry with backoff while keeping manual retry available.
- [ ] Prevent save/profile controls from rendering against absent or stale data.
- [ ] Apply the same typed API error model used by session hydration.

**Regression tests:**

- [ ] Fail the first settings request and succeed on retry; assert the form becomes usable.
- [ ] Verify loading, error, empty-valid settings, and successful data render distinctly.

**Acceptance criteria:** A transient settings API failure is recoverable without a full page reload.

---

## P2-05 — Reject arrays and incomplete settings replacement payloads

- [x] Prevent malformed PUT requests from silently clearing configuration.

**Confidence:** High

**Relevant code:**

- `backend/routes/settings.js`
- `backend/services/settings-validation.js`
- `backend/services/settings.js`
- `backend/tests/settings-validation.test.js`

**Problem:** Validation accepts any non-null JavaScript object, including arrays. Missing list fields
are converted to empty arrays and scalar fields receive defaults, then the singleton document is fully
replaced. Authenticated requests containing `[]`, `{}`, or a partial object can therefore clear video
extensions and user profiles while returning `settings_saved`.

**Implementation tasks:**

- [ ] Require a plain, non-array object for the replacement endpoint.
- [ ] Require every top-level replacement field with its exact container type.
- [ ] Reject malformed nested arrays/objects instead of silently defaulting them.
- [ ] If partial updates are desired, expose explicit PATCH semantics that preserve omitted fields.
- [ ] Leave the stored document unchanged on every validation failure.

**Regression tests:**

- [ ] Reject `[]`, `{}`, missing `videoExtensions`, missing `transcodeSettings`, and wrong container types.
- [ ] Assert persisted settings remain byte-for-byte equivalent after each rejected request.
- [ ] Retain a positive test for a complete valid replacement and separate PATCH tests if introduced.

**Acceptance criteria:** No malformed or partial replacement request can destructively default omitted
configuration while reporting success.

---

## P3-01 — Skip files that disappear between discovery and stat

- [x] Stop creating permanent phantom documents from the scan race window.

**Confidence:** High

**Relevant code:**

- `backend/services/scanner.js`

**Problem:** If a discovered file disappears before `stat`, the catch says to skip silently but
execution continues and inserts a size-zero file document. Future scans skip that path because the
deterministic `fileId` already exists. If a real file later appears at the same path, it is not
rediscovered or reprobed automatically.

**Implementation tasks:**

- [ ] Continue the discovery loop on `ENOENT` instead of inserting a document.
- [ ] Log or surface other stat failures according to whether they are permission or transient errors.
- [ ] Consider refreshing stale failed documents when the path later becomes readable.

**Regression tests:**

- [ ] Return a path from `readdir`, reject `stat` with `ENOENT`, and assert no document/job is created.
- [ ] Make the next scan's `stat` succeed and assert normal discovery/probe.
- [ ] Cover permission failures without creating a misleading size-zero document.

**Acceptance criteria:** A vanished discovery never creates a document that blocks later real discovery.

---

## P3-02 — Expose Stop for pending files in the dashboard

- [x] Align frontend stoppable statuses with the backend contract.

**Confidence:** High

**Relevant code:**

- `frontend/src/components/dashboard/filestab.js`
- `backend/controllers/files/mutations.js`
- `shared/domain.js`

**Problem:** The backend allows stopping `pending`, `queued`, and `processing` files, but the dashboard
shows Stop only for queued/processing. A user cannot stop a pending discovery/recovery item through the
UI; the visible Delete action removes the source rather than merely stopping work.

**Implementation tasks:**

- [ ] Add a shared `STOPPABLE_STATUSES` contract or equivalent helper used by both layers.
- [ ] Render Stop for pending files with the existing confirmation flow.
- [ ] Keep terminal-status negative cases explicit.

**Regression tests:**

- [ ] Render a pending row, assert Stop is visible, confirm it calls the stop API, and refresh state.
- [ ] Assert Stop remains hidden for terminal statuses.

**Acceptance criteria:** Every status accepted by the stop API is reachable through the dashboard.

---

## Completion gate for this backlog

Before marking the correctness review complete:

- [ ] Add focused unit tests for every item above; add filesystem/WebSocket/database integration tests
      where unit tests cannot prove lifecycle safety.
- [ ] Add frontend hook/component tests for session, settings, polling, and action-state behavior.
- [ ] Run backend tests, frontend/backend lint, formatting checks, and a production build.
- [ ] Run a container smoke test for monitor startup, health, scan/probe, adjacent transcode, overwrite
      transcode, stop, requeue, runner disconnect, restart recovery, and clean shutdown.
- [ ] Run the same transcode lifecycle with at least two runners and multiple matching profiles.
- [ ] Verify no test leaves media, output reservations, jobs, files, runner assignments, cancellation
      flags, or overwrite journals in contradictory states.
