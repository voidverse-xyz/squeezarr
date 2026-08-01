import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFinalOutputPath, buildOutputPath, inspectOutputCollision } from "../services/ffmpeg/prepare.js";
import { promoteAdjacentScratch, validateOutput } from "../services/ffmpeg/finalize.js";
import { deriveAggregateStatus } from "../services/ffmpeg/results.js";
import {
    isOwner,
    adjacentRecoveryAction,
    reconcileAdjacentFilesystem,
    overwriteRecoveryAction,
    reconcileOverwriteFilesystem,
    recoverProbeOwners,
    updateFileLifecycle,
    recomputeFileStatus,
    preparedTaskMatches,
    terminalOwnerCanRelease,
    withFileLifecycleCriticalSection,
    interruptedRecoveryStatus,
    failedOwnerCanRelease,
    isFailureFinalizing,
    recoveredOwnerNeedsRelease,
} from "../services/processing.js";
import {
    deleteTrackedOutput,
    hasUnsettledLifecycle,
    publishProbeJob,
    stopFailureForFile,
    transitionFileToStopped,
    stop,
} from "../controllers/files/mutations.js";
import { belongsToProbeGeneration, selectPrunableFinished } from "../services/job.js";
import { clearProbeOwnerForJob } from "../services/event/recovery.js";
import { dispatchTranscodes, resetTranscode, settleJobForMissingFile } from "../services/event/dispatch.js";
import { FILE_STATUS, JOB_STATUS, OUTPUT_MODE, RESULT_STATUS, JOB_TYPE } from "shared/domain.js";
import { MAX_PAGE_SIZE } from "../utilities/constants.js";

const adjacent = (overrides = {}) => ({
    id: "setting-a",
    name: "Adjacent",
    outputMode: OUTPUT_MODE.adjacent,
    suffix: ".hevc",
    ...overrides,
});

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

test("scratch paths are preparation-generation-owned and cannot collide after reassignment", () => {
    const file = { path: "/data/movie.mkv" };
    const setting = adjacent();
    const first = buildOutputPath(file, setting, "same-job", "generation-one");
    const second = buildOutputPath(file, setting, "same-job", "generation-two");
    assert.notEqual(first, second);
    assert.match(first, /same-job\.generation-one/);
    assert.match(second, /same-job\.generation-two/);
    assert.equal(buildFinalOutputPath(file, setting), "/data/movie.hevc.mkv");
});

test("adjacent reservation rejects an existing unrelated source without changing either file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "squeezarr-collision-"));
    try {
        const sourcePath = path.join(dir, "movie.mkv");
        const collisionPath = path.join(dir, "movie.hevc.mkv");
        await writeFile(sourcePath, "source");
        await writeFile(collisionPath, "unrelated");
        const file = { fileId: "source", path: sourcePath };
        const setting = adjacent();
        const message = await inspectOutputCollision({
            files: [file, { fileId: "other", path: collisionPath }],
            file,
            setting,
            job: { payload: {} },
            outputPath: buildFinalOutputPath(file, setting),
        });
        assert.match(message, /owned as source by file other/);
        assert.equal(await readFile(sourcePath, "utf8"), "source");
        assert.equal(await readFile(collisionPath, "utf8"), "unrelated");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("two settings resolving to one active destination collide, while explicit same-result regeneration is allowed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "squeezarr-reservation-"));
    try {
        const file = { fileId: "source", path: path.join(dir, "movie.mkv") };
        const outputPath = buildFinalOutputPath(file, adjacent());
        const active = { ...file, reservedOutputPath: outputPath, activeJobId: "first" };
        const collision = await inspectOutputCollision({
            files: [active],
            file,
            setting: adjacent({ id: "setting-b" }),
            job: { payload: {} },
            outputPath,
        });
        assert.match(collision, /reserved output/);

        await writeFile(outputPath, "owned output");
        const completed = {
            ...file,
            transcodeResults: [{ settingId: "setting-a", outputPath }],
        };
        const allowed = await inspectOutputCollision({
            files: [completed],
            file,
            setting: adjacent(),
            job: { payload: { regenerateOwnedOutput: true } },
            outputPath,
        });
        assert.equal(allowed, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("adjacent promotion never replaces a late unrelated destination collision", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "squeezarr-promote-"));
    try {
        const scratch = path.join(dir, "scratch.mkv");
        const final = path.join(dir, "final.mkv");
        await writeFile(scratch, "task output");
        await writeFile(final, "unrelated");
        await assert.rejects(promoteAdjacentScratch(scratch, final), (error) => error.code === "EEXIST");
        assert.equal(await readFile(final, "utf8"), "unrelated");
        assert.equal(await readFile(scratch, "utf8"), "task output");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("output validation requires a readable regular non-symlink file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "squeezarr-output-"));
    try {
        const output = path.join(dir, "out.mkv");
        await assert.rejects(validateOutput(output), /ENOENT/);
        await mkdir(output);
        await assert.rejects(validateOutput(output), /not a regular file/);
        await rm(output, { recursive: true });
        const target = path.join(dir, "target.mkv");
        await writeFile(target, "media");
        await symlink(target, output);
        await assert.rejects(validateOutput(output), /not a regular file/);
        await rm(output);
        await writeFile(output, "media");
        assert.equal((await validateOutput(output)).size, 5);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("aggregate profile status is completion-order independent and preserves usable output", () => {
    const base = { status: FILE_STATUS.queued, activeJobId: null, replaced: false };
    const done = { status: RESULT_STATUS.done, outputPath: "/data/out.mkv" };
    const failed = { status: RESULT_STATUS.failed };
    const rejected = { status: RESULT_STATUS.rejected };
    assert.equal(deriveAggregateStatus({ ...base, transcodeResults: [rejected, done] }), FILE_STATUS.transcoded);
    assert.equal(deriveAggregateStatus({ ...base, transcodeResults: [done, rejected] }), FILE_STATUS.transcoded);
    assert.equal(deriveAggregateStatus({ ...base, transcodeResults: [failed, done] }), FILE_STATUS.transcoded);
    assert.equal(deriveAggregateStatus({ ...base, transcodeResults: [done, failed] }), FILE_STATUS.transcoded);
    assert.equal(deriveAggregateStatus({ ...base, transcodeResults: [rejected, rejected] }), FILE_STATUS.rejected);
    assert.equal(deriveAggregateStatus({ ...base, transcodeResults: [rejected, failed] }), FILE_STATUS.failed);
    assert.equal(
        deriveAggregateStatus({ ...base, transcodeResults: [done] }, [{ jobId: "pending-third" }]),
        FILE_STATUS.queued,
    );
});

test("held aggregate recomputation cannot cross requeue into a fresh probe generation", async () => {
    const fileId = "aggregate-requeue-boundary";
    let file = {
        fileId,
        status: FILE_STATUS.failed,
        activeJobId: null,
        activeProbeJobId: null,
        transcodeResults: [{ settingId: "old", status: RESULT_STATUS.failed }],
    };
    const activeJobReadEntered = deferred();
    const finishActiveJobRead = deferred();
    let requeueEntered = false;

    const staleRecompute = recomputeFileStatus(
        fileId,
        {},
        {
            listActiveJobs: async () => {
                activeJobReadEntered.resolve();
                await finishActiveJobRead.promise;
                return [];
            },
            updateFile: async (_id, updateFn) => {
                file = await updateFn(file);
                return file;
            },
        },
    );
    await activeJobReadEntered.promise;

    const requeue = withFileLifecycleCriticalSection(fileId, async () => {
        requeueEntered = true;
        file = {
            ...file,
            status: FILE_STATUS.pending,
            activeProbeJobId: "fresh-probe",
            transcodeResults: [],
        };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requeueEntered, false, "requeue waits for the aggregate read/write boundary");

    finishActiveJobRead.resolve();
    await Promise.all([staleRecompute, requeue]);
    assert.equal(file.status, FILE_STATUS.pending, "the stale aggregate write finishes before requeue publication");
    assert.equal(file.activeProbeJobId, "fresh-probe");

    let probePublished = false;
    await updateFileLifecycle(
        fileId,
        (current) => {
            if (current?.activeProbeJobId !== "fresh-probe" || current.status !== FILE_STATUS.pending) {
                return current;
            }
            probePublished = true;
            return { ...current, status: FILE_STATUS.queued, activeProbeJobId: null };
        },
        async (_collection, _id, updateFn) => {
            file = await updateFn(file);
            return file;
        },
    );
    assert.equal(probePublished, true, "the fresh probe still observes its pending generation");
    assert.equal(file.status, FILE_STATUS.queued);
    assert.equal(file.activeProbeJobId, null);
});

test("jobId ownership fences stale generations and journal phases choose deterministic recovery", () => {
    const file = { activeJobId: "new", activeSettingId: "setting" };
    assert.equal(isOwner(file, "old", "setting"), false);
    assert.equal(isOwner(file, "new", "other"), false);
    assert.equal(isOwner(file, "new", "setting"), true);
    assert.equal(adjacentRecoveryAction({ phase: "prepared" }), "roll-back");
    assert.equal(adjacentRecoveryAction({ phase: "promoting" }), "roll-back");
    assert.equal(adjacentRecoveryAction({ phase: "committed" }), "roll-forward");
    assert.equal(overwriteRecoveryAction({ phase: "prepared" }), "roll-back");
    assert.equal(overwriteRecoveryAction({ phase: "replacing" }), "roll-back");
    assert.equal(overwriteRecoveryAction({ phase: "committed" }), "roll-forward");
    assert.equal(overwriteRecoveryAction({ phase: "cleaned" }), "roll-forward");
});

test("adjacent promotion recovery removes only task-owned finals and keeps committed output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "squeezarr-adjacent-journal-"));
    try {
        const scratchPath = path.join(dir, "scratch.mkv");
        const finalPath = path.join(dir, "final.mkv");
        const journal = { scratchPath, finalPath };

        await writeFile(scratchPath, "task output");
        await link(scratchPath, finalPath);
        await reconcileAdjacentFilesystem(journal, "roll-back");
        await assert.rejects(access(scratchPath), /ENOENT/);
        await assert.rejects(access(finalPath), /ENOENT/);

        await writeFile(scratchPath, "task output");
        await writeFile(finalPath, "unrelated collision");
        await reconcileAdjacentFilesystem(journal, "roll-back");
        assert.equal(await readFile(finalPath, "utf8"), "unrelated collision");
        await assert.rejects(access(scratchPath), /ENOENT/);

        await rm(finalPath);
        await writeFile(scratchPath, "committed output");
        await link(scratchPath, finalPath);
        await reconcileAdjacentFilesystem(journal, "roll-forward");
        assert.equal(await readFile(finalPath, "utf8"), "committed output");
        await assert.rejects(access(scratchPath), /ENOENT/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("overwrite filesystem recovery rolls back uncommitted replacement and rolls forward committed cleanup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "squeezarr-journal-"));
    try {
        const sourcePath = path.join(dir, "movie.mkv");
        const tempPath = path.join(dir, "temp.mkv");
        const backupPath = path.join(dir, "backup.mkv");
        const journal = { sourcePath, tempPath, backupPath };

        // Crash after source→backup and temp→source but before the committed journal write.
        await writeFile(sourcePath, "replacement");
        await writeFile(backupPath, "original");
        await writeFile(tempPath, "partial");
        await reconcileOverwriteFilesystem(journal, "roll-back");
        assert.equal(await readFile(sourcePath, "utf8"), "original");
        await assert.rejects(access(backupPath), /ENOENT/);
        await assert.rejects(access(tempPath), /ENOENT/);
        // Repeating recovery is harmless.
        await reconcileOverwriteFilesystem(journal, "roll-back");
        assert.equal(await readFile(sourcePath, "utf8"), "original");

        // Once committed, replacement bytes stay authoritative and only the backup is cleaned.
        await writeFile(sourcePath, "replacement");
        await writeFile(backupPath, "original");
        await reconcileOverwriteFilesystem(journal, "roll-forward");
        assert.equal(await readFile(sourcePath, "utf8"), "replacement");
        await assert.rejects(access(backupPath), /ENOENT/);
        await reconcileOverwriteFilesystem(journal, "roll-forward");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("tracked deletion clears ENOENT but preserves ownership for filesystem failures", async () => {
    const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
    assert.deepEqual(await deleteTrackedOutput("/out", async () => Promise.reject(enoent)), { deleted: true });
    for (const code of ["EACCES", "EBUSY", "EROFS"]) {
        const error = Object.assign(new Error(code), { code });
        const result = await deleteTrackedOutput("/out", async () => Promise.reject(error));
        assert.equal(result.deleted, false);
        assert.equal(result.error, error);
    }
});

test("dispatch selects only the highest-priority job for a file in one pass", async () => {
    const claimed = [];
    const assigned = [];
    const jobs = [
        { jobId: "high", payload: { fileId: "same" } },
        { jobId: "low", payload: { fileId: "same" } },
        { jobId: "other", payload: { fileId: "other" } },
    ];
    const result = await dispatchTranscodes(jobs, {
        idleRunnerCount: () => 3,
        isPaused: async () => false,
        getFile: async () => ({ activeJobId: null }),
        validatePrepared: async () => true,
        job: {
            claim: async (jobId) => {
                claimed.push(jobId);
                const pending = jobs.find((item) => item.jobId === jobId);
                return { ...pending, type: JOB_TYPE.TRANSCODE_FILE };
            },
            complete: async () => {},
            fail: async () => {},
        },
        prepare: async (job) => ({ fileId: job.payload.fileId }),
        assign: async (jobId) => {
            assigned.push(jobId);
            return true;
        },
        reset: async () => {},
    });
    assert.equal(result, "saturated");
    assert.deepEqual(claimed, ["high", "other"]);
    assert.deepEqual(assigned, ["high", "other"]);
});

test("dispatch leaves a file with an existing durable owner pending", async () => {
    const claimed = [];
    const result = await dispatchTranscodes([{ jobId: "sibling", payload: { fileId: "owned" } }], {
        idleRunnerCount: () => 2,
        isPaused: async () => false,
        getFile: async () => ({ activeJobId: "running-job" }),
        validatePrepared: async () => true,
        job: { claim: async (id) => claimed.push(id), complete: async () => {}, fail: async () => {} },
        prepare: async () => assert.fail("must not prepare"),
        assign: async () => assert.fail("must not assign"),
        reset: async () => {},
    });
    assert.equal(result, "saturated");
    assert.deepEqual(claimed, []);
});

test("startup clears absent and terminal probe owners but preserves active probe jobs", async () => {
    const files = [
        { fileId: "absent", activeProbeJobId: "missing" },
        { fileId: "done", activeProbeJobId: "done-job" },
        { fileId: "failed", activeProbeJobId: "failed-job" },
        { fileId: "pending", activeProbeJobId: "pending-job" },
        { fileId: "running", activeProbeJobId: "running-job" },
    ];
    const jobs = new Map([
        ["done-job", { status: JOB_STATUS.done }],
        ["failed-job", { status: JOB_STATUS.failed }],
        ["pending-job", { status: JOB_STATUS.pending }],
        ["running-job", { status: JOB_STATUS.running }],
    ]);
    const cleared = [];
    const recovered = await recoverProbeOwners({
        getFiles: async () => files,
        getJob: async (jobId) => jobs.get(jobId) || null,
        clearOwner: async (fileId, jobId) => cleared.push({ fileId, jobId }),
    });

    assert.equal(recovered, 3);
    assert.deepEqual(cleared, [
        { fileId: "absent", jobId: "missing" },
        { fileId: "done", jobId: "done-job" },
        { fileId: "failed", jobId: "failed-job" },
    ]);
});

async function runProbeStopRace(fileId, firstTransition, secondTransition) {
    let state = { fileId, status: FILE_STATUS.pending, activeProbeJobId: "probe" };
    let releaseFirst;
    let markEntered;
    const entered = new Promise((resolve) => {
        markEntered = resolve;
    });
    const firstCanFinish = new Promise((resolve) => {
        releaseFirst = resolve;
    });
    let updates = 0;
    const updateDocument = async (_collection, _id, updateFn) => {
        const updated = updateFn({ ...state });
        updates++;
        if (updates === 1) {
            markEntered();
            await firstCanFinish;
        }
        state = updated;
        return updated;
    };

    const first = updateFileLifecycle(fileId, firstTransition, updateDocument);
    await entered;
    const second = updateFileLifecycle(fileId, secondTransition, updateDocument);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates, 1, "the second lifecycle writer waits outside the facade read/write window");
    releaseFirst();
    await Promise.all([first, second]);
    return state;
}

test("destructive lifecycle critical section excludes prepare through side effects and document removal", async () => {
    let state = { fileId: "destructive", status: FILE_STATUS.transcoded };
    let releaseDestructive;
    let enteredDestructive;
    const destructiveEntered = new Promise((resolve) => {
        enteredDestructive = resolve;
    });
    const destructiveCanFinish = new Promise((resolve) => {
        releaseDestructive = resolve;
    });
    let prepareEntered = false;

    const destructive = withFileLifecycleCriticalSection("destructive", async () => {
        assert.equal(state.activeJobId, undefined);
        enteredDestructive();
        await destructiveCanFinish;
        state = null;
    });
    await destructiveEntered;
    const prepare = updateFileLifecycle(
        "destructive",
        (file) => {
            prepareEntered = true;
            return file ? { ...file, activeJobId: "job" } : file;
        },
        async (_collection, _id, updateFn) => {
            state = updateFn(state);
            return state;
        },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prepareEntered, false, "prepare cannot claim during destructive filesystem work");
    releaseDestructive();
    await Promise.all([destructive, prepare]);
    assert.equal(prepareEntered, true);
    assert.equal(state, null, "prepare observes the removed document and cannot recreate it");
});

test("Stop captures an owner assigned at the read boundary and preserves it through cancellation cleanup", async () => {
    let file = { fileId: "stop-assignment-race", path: "/media/input.mkv", status: FILE_STATUS.queued };
    const staleObservationBeforeAssignment = { ...file };
    const jobs = new Map([
        ["active", { jobId: "active", status: JOB_STATUS.pending }],
        ["sibling", { jobId: "sibling", status: JOB_STATUS.pending }],
    ]);
    let assignmentEntered;
    let publishAssignment;
    const entered = new Promise((resolve) => {
        assignmentEntered = resolve;
    });
    const canPublish = new Promise((resolve) => {
        publishAssignment = resolve;
    });

    const assignment = withFileLifecycleCriticalSection(file.fileId, async () => {
        assignmentEntered();
        await canPublish;
        file = {
            ...file,
            status: FILE_STATUS.processing,
            activeJobId: "active",
            activePhase: "processing",
            currentOutputPath: "/media/.active.partial",
            adjacentJournal: { jobId: "active", phase: "prepared" },
        };
        jobs.set("active", { jobId: "active", status: JOB_STATUS.running });
    });
    await entered;

    const failedExcept = [];
    let wakeups = 0;
    const stopRequest = stop(file.fileId, {
        transition: (fileId) =>
            transitionFileToStopped(fileId, {
                withCriticalSection: withFileLifecycleCriticalSection,
                getFile: async () => file,
                updateFile: async (_id, updateFn) => {
                    file = updateFn(file);
                    return file;
                },
                getOutstandingJobs: async () => [...jobs.values()],
            }),
        failJob: async (jobId) => {
            failedExcept.push(jobId);
            const job = jobs.get(jobId);
            if (job && [JOB_STATUS.pending, JOB_STATUS.running].includes(job.status)) {
                jobs.set(jobId, { ...job, status: JOB_STATUS.failed });
            }
        },
        wakeup: () => wakeups++,
        log: () => {},
    });

    // The Stop request is waiting on the lifecycle section while dispatch finishes publication.
    publishAssignment();
    await Promise.all([assignment, stopRequest]);

    assert.equal(staleObservationBeforeAssignment.activeJobId, undefined, "the pre-assignment read had no owner");
    assert.equal(file.status, FILE_STATUS.stopped);
    assert.equal(file.cancelled, true);
    assert.equal(file.activeJobId, "active");
    assert.deepEqual(failedExcept, ["sibling"], "failure targets exclude the owner captured under the lock");
    assert.equal(jobs.get("active").status, JOB_STATUS.running, "active job remains result-finalizable");
    assert.equal(jobs.get("sibling").status, JOB_STATUS.failed, "other outstanding work is stopped");
    assert.equal(wakeups, 1);

    // Model the cancellation result's finalization: it alone completes and releases its journals.
    jobs.set("active", { ...jobs.get("active"), status: JOB_STATUS.done });
    file = {
        ...file,
        cancelled: false,
        activeJobId: null,
        activePhase: null,
        currentOutputPath: null,
        adjacentJournal: null,
    };
    assert.equal(jobs.get("active").status, JOB_STATUS.done);
    assert.equal(file.activeJobId, null);
    assert.equal(file.adjacentJournal, null);
});

async function runProbeStopRequeueRace(probeStatus) {
    const fileId = `probe-stop-${probeStatus}`;
    const oldProbeJobId = `old-probe-${probeStatus}`;
    const newProbeJobId = `new-probe-${probeStatus}`;
    let file = {
        fileId,
        path: "/media/probe.mkv",
        status: FILE_STATUS.pending,
        activeProbeJobId: oldProbeJobId,
    };
    const jobs = new Map([
        [oldProbeJobId, { jobId: oldProbeJobId, type: JOB_TYPE.PROBE_FILE, status: probeStatus, payload: { fileId } }],
    ]);

    const result = await stop(fileId, {
        transition: (id) =>
            transitionFileToStopped(id, {
                withCriticalSection: withFileLifecycleCriticalSection,
                getFile: async () => file,
                updateFile: async (_id, updateFn) => {
                    file = updateFn(file);
                    return file;
                },
                getOutstandingJobs: async () => [...jobs.values()],
            }),
        failJob: async (jobId) => {
            const job = jobs.get(jobId);
            if (job && [JOB_STATUS.pending, JOB_STATUS.running].includes(job.status)) {
                jobs.set(jobId, { ...job, status: JOB_STATUS.failed });
            }
        },
        wakeup: () => {},
        log: () => {},
    });

    assert.equal(result.success, true);
    assert.equal(file.status, FILE_STATUS.stopped);
    assert.equal(file.activeProbeJobId, null, "Stop clears probe ownership in its serialized transition");
    assert.equal(jobs.get(oldProbeJobId).status, JOB_STATUS.failed);
    assert.equal(hasUnsettledLifecycle(file), false, "cleared probe ownership cannot block immediate requeue");

    // Immediate requeue publishes a fresh generation.
    await withFileLifecycleCriticalSection(fileId, async () => {
        file = { ...file, status: FILE_STATUS.pending, activeProbeJobId: newProbeJobId };
        jobs.set(newProbeJobId, {
            jobId: newProbeJobId,
            type: JOB_TYPE.PROBE_FILE,
            status: JOB_STATUS.pending,
            payload: { fileId },
        });
    });

    // A late callback from the old running probe is owner-fenced and cannot publish or clear the
    // new generation. A child enqueued in the old probe's last-check/enqueue window is scoped to
    // that old generation and cannot cause the new probe to fail.
    jobs.set("late-old-child", {
        jobId: "late-old-child",
        type: JOB_TYPE.TRANSCODE_FILE,
        status: JOB_STATUS.pending,
        payload: { fileId, probeJobId: oldProbeJobId },
    });
    await updateFileLifecycle(
        fileId,
        (current) =>
            current?.activeProbeJobId === oldProbeJobId
                ? { ...current, status: FILE_STATUS.queued, activeProbeJobId: null }
                : current,
        async (_collection, _id, updateFn) => {
            file = updateFn(file);
            return file;
        },
    );
    for (const [jobId, job] of jobs) {
        if (belongsToProbeGeneration(job, fileId, oldProbeJobId)) {
            jobs.set(jobId, { ...job, status: JOB_STATUS.failed });
        }
    }
    assert.equal(file.status, FILE_STATUS.pending);
    assert.equal(file.activeProbeJobId, newProbeJobId);
    assert.equal(jobs.get("late-old-child").status, JOB_STATUS.failed);
    assert.equal(jobs.get(newProbeJobId).status, JOB_STATUS.pending);
}

test("Stop clears a pending probe owner and immediate requeue publishes a fresh generation", async () => {
    await runProbeStopRequeueRace(JOB_STATUS.pending);
});

test("Stop fences a running probe callback from an immediate requeue generation", async () => {
    await runProbeStopRequeueRace(JOB_STATUS.running);
});

test("reset settles a running job when its file vanished", () => {
    const settled = settleJobForMissingFile({ jobId: "job", status: JOB_STATUS.running });
    assert.equal(settled.status, JOB_STATUS.failed);
    assert.match(settled.error, /File removed/);
    assert.equal(settleJobForMissingFile({ jobId: "job", status: JOB_STATUS.done }).status, JOB_STATUS.done);
});

function lifecycleUpdater(fileId, getFile, setFile) {
    return (updateFn) =>
        updateFileLifecycle(fileId, updateFn, async (_collection, _id, apply) => {
            const updated = await apply(getFile());
            setFile(updated);
            return updated;
        });
}

test("stop winning the file boundary makes reset settle only the stopped generation", async () => {
    const fileId = "reset-stop-boundary";
    let file = {
        fileId,
        status: FILE_STATUS.processing,
        activeJobId: "old-job",
        activeSettingId: "setting",
        activePhase: "processing",
        currentOutputPath: "/data/.old.partial",
        cancelled: false,
    };
    let job = { jobId: "old-job", status: JOB_STATUS.running };
    const stopEntered = deferred();
    const finishStop = deferred();
    const stopWinner = withFileLifecycleCriticalSection(fileId, async () => {
        stopEntered.resolve();
        await finishStop.promise;
        file = { ...file, status: FILE_STATUS.stopped, cancelled: true };
    });
    await stopEntered.promise;

    const reset = resetTranscode(job.jobId, fileId, {
        updateFileLifecycle: lifecycleUpdater(
            fileId,
            () => file,
            (updated) => {
                file = updated;
            },
        ),
        updateJob: async (updateFn) => {
            job = await updateFn(job);
            return job;
        },
    });
    finishStop.resolve();
    const [, disposition] = await Promise.all([stopWinner, reset]);

    assert.equal(disposition, "stopped");
    assert.equal(job.status, JOB_STATUS.failed);
    assert.equal(file.status, FILE_STATUS.stopped);
    assert.equal(file.activeJobId, null);
});

test("completion winning the job boundary prevents reset from clearing terminal ownership", async () => {
    const fileId = "reset-complete-boundary";
    let file = {
        fileId,
        status: FILE_STATUS.processing,
        activeJobId: "terminal-job",
        activeSettingId: "setting",
        activePhase: "committing",
    };
    let job = { jobId: "terminal-job", status: JOB_STATUS.running };
    let jobTail = Promise.resolve();
    const mutateJob = async (updateFn) => {
        const previous = jobTail;
        let releaseTurn;
        jobTail = new Promise((resolve) => {
            releaseTurn = resolve;
        });
        await previous;
        try {
            job = await updateFn(job);
            return job;
        } finally {
            releaseTurn();
        }
    };
    const completionEntered = deferred();
    const finishCompletion = deferred();
    const completion = mutateJob(async (current) => {
        completionEntered.resolve();
        await finishCompletion.promise;
        return { ...current, status: JOB_STATUS.done };
    });
    await completionEntered.promise;
    const resetAtJobBoundary = deferred();
    const reset = resetTranscode(job.jobId, fileId, {
        updateFileLifecycle: lifecycleUpdater(
            fileId,
            () => file,
            (updated) => {
                file = updated;
            },
        ),
        updateJob: (updateFn) => {
            resetAtJobBoundary.resolve();
            return mutateJob(updateFn);
        },
    });
    await resetAtJobBoundary.promise;
    finishCompletion.resolve();
    const [, disposition] = await Promise.all([completion, reset]);

    assert.equal(disposition, "stale");
    assert.equal(job.status, JOB_STATUS.done);
    assert.equal(file.activeJobId, "terminal-job");
    assert.equal(file.activePhase, "committing");
});

test("requeue winning the file boundary fences late reset from the new probe generation", async () => {
    const fileId = "reset-requeue-boundary";
    let file = {
        fileId,
        status: FILE_STATUS.processing,
        activeJobId: "old-job",
        activePhase: "processing",
    };
    let job = { jobId: "old-job", status: JOB_STATUS.running };
    const requeueEntered = deferred();
    const finishRequeue = deferred();
    const requeueWinner = withFileLifecycleCriticalSection(fileId, async () => {
        requeueEntered.resolve();
        await finishRequeue.promise;
        job = { ...job, status: JOB_STATUS.failed };
        file = {
            fileId,
            status: FILE_STATUS.pending,
            activeJobId: null,
            activePhase: null,
            activeProbeJobId: "new-probe",
        };
    });
    await requeueEntered.promise;
    const reset = resetTranscode(job.jobId, fileId, {
        updateFileLifecycle: lifecycleUpdater(
            fileId,
            () => file,
            (updated) => {
                file = updated;
            },
        ),
        updateJob: async (updateFn) => {
            job = await updateFn(job);
            return job;
        },
    });
    finishRequeue.resolve();
    const [, disposition] = await Promise.all([requeueWinner, reset]);

    assert.equal(disposition, "stale");
    assert.equal(job.status, JOB_STATUS.failed);
    assert.equal(file.status, FILE_STATUS.pending);
    assert.equal(file.activeProbeJobId, "new-probe");
});

test("serialized prepare claim and stop preserve stop and fence assignment in both interleavings", async () => {
    const prepareClaim = (file) =>
        file.status === FILE_STATUS.stopped || file.activeJobId
            ? file
            : {
                  ...file,
                  status: FILE_STATUS.processing,
                  activeJobId: "transcode",
                  activeSettingId: "setting",
                  activePhase: "processing",
                  currentOutputPath: "/scratch",
              };
    const stop = (file) => ({ ...file, status: FILE_STATUS.stopped, cancelled: Boolean(file.activeJobId) });
    const job = {
        jobId: "transcode",
        status: JOB_STATUS.running,
        payload: { settingId: "setting" },
        preparedOutputPath: "/scratch",
    };
    const prepared = { fileId: "prepare-first", outputPath: "/scratch" };

    const prepareFirst = await runProbeStopRace("prepare-first", prepareClaim, stop);
    assert.equal(prepareFirst.status, FILE_STATUS.stopped);
    assert.equal(preparedTaskMatches(prepareFirst, job, prepared), false);

    const stopFirst = await runProbeStopRace("stop-first-transcode", stop, prepareClaim);
    assert.equal(stopFirst.status, FILE_STATUS.stopped);
    assert.equal(preparedTaskMatches(stopFirst, job, { ...prepared, fileId: "stop-first-transcode" }), false);
});

test("serialized probe and stop publications preserve acknowledged stop in both interleavings", async () => {
    const probePublish = (file) =>
        file.status === FILE_STATUS.pending ? { ...file, status: FILE_STATUS.queued } : file;
    const stop = (file) => ({ ...file, status: FILE_STATUS.stopped });

    assert.equal((await runProbeStopRace("probe-first", probePublish, stop)).status, FILE_STATUS.stopped);
    assert.equal((await runProbeStopRace("stop-first", stop, probePublish)).status, FILE_STATUS.stopped);
});

test("probe-generation cleanup never targets jobs from a newer requeue", () => {
    const oldJob = {
        type: JOB_TYPE.TRANSCODE_FILE,
        payload: { fileId: "file", probeJobId: "old-probe" },
    };
    const newJob = {
        type: JOB_TYPE.TRANSCODE_FILE,
        payload: { fileId: "file", probeJobId: "new-probe" },
    };
    assert.equal(belongsToProbeGeneration(oldJob, "file", "old-probe"), true);
    assert.equal(belongsToProbeGeneration(newJob, "file", "old-probe"), false);
    assert.equal(belongsToProbeGeneration(oldJob, "other", "old-probe"), false);
});

test("interrupted probe recovery clears matching owner on both success and failure paths", () => {
    const file = { fileId: "file", activeProbeJobId: "probe" };
    assert.equal(clearProbeOwnerForJob(file, "probe").activeProbeJobId, null);
    assert.equal(clearProbeOwnerForJob(file, "newer"), file);
});

test("interrupted journal rollback preserves stopped and only queues non-stopped work", () => {
    assert.equal(interruptedRecoveryStatus({ status: FILE_STATUS.stopped }), FILE_STATUS.stopped);
    assert.equal(interruptedRecoveryStatus({ status: FILE_STATUS.processing, cancelled: true }), FILE_STATUS.stopped);
    assert.equal(interruptedRecoveryStatus({ status: FILE_STATUS.processing }), FILE_STATUS.queued);
});

test("restart distinguishes a persisted failure commit from an ordinary prepared interruption", () => {
    const journal = { jobId: "failure-job", settingId: "setting-a", phase: "prepared" };
    const failureCrash = {
        activeJobId: journal.jobId,
        activePhase: "committing",
        failureMessage: "ffmpeg failed before result persistence",
        adjacentJournal: journal,
    };
    assert.equal(adjacentRecoveryAction(journal), "roll-back");
    assert.equal(isFailureFinalizing(failureCrash, journal), true);
    assert.equal(isFailureFinalizing({ ...failureCrash, failureMessage: null }, journal), false);
    assert.equal(isFailureFinalizing({ ...failureCrash, activeJobId: "new-job" }, journal), false);
});

test("adjacent cleaned-journal restart is idempotent with or without the original owner", () => {
    const journal = { jobId: "success-job", phase: "cleaned" };
    assert.equal(adjacentRecoveryAction(journal), "roll-forward");
    assert.equal(recoveredOwnerNeedsRelease({ activeJobId: journal.jobId }, journal), true);
    assert.equal(
        recoveredOwnerNeedsRelease({ activeJobId: null, status: FILE_STATUS.transcoded }, journal),
        false,
        "already-released durable success must not require a second release gate",
    );
    assert.equal(recoveredOwnerNeedsRelease({ activeJobId: "new-job" }, journal), false);
});

test("finished-job pruning retains old lifecycle evidence beyond the history limit until release", () => {
    const protectedJob = {
        jobId: "retained-failure-job",
        status: JOB_STATUS.failed,
        finishedAt: 1,
    };
    const newerHistory = Array.from({ length: MAX_PAGE_SIZE + 7 }, (_, index) => ({
        jobId: `newer-${index}`,
        status: JOB_STATUS.done,
        finishedAt: MAX_PAGE_SIZE + 100 - index,
    }));
    const finishedNewestFirst = [...newerHistory, protectedJob];
    const file = {
        fileId: "retained-failure-file",
        activeJobId: protectedJob.jobId,
        activeSettingId: "setting-a",
        activePhase: "committing",
        failureMessage: "cleanup pending",
        status: FILE_STATUS.failed,
        currentOutputPath: "/media/.retained.partial",
        adjacentJournal: { jobId: protectedJob.jobId, phase: "cleaned" },
        transcodeResults: [{ settingId: "setting-a", status: RESULT_STATUS.failed }],
    };

    const prunable = selectPrunableFinished(finishedNewestFirst, [file], MAX_PAGE_SIZE);
    assert.equal(prunable.length, 7);
    assert.equal(
        prunable.some((job) => job.jobId === protectedJob.jobId),
        false,
    );
    const retainedJobs = finishedNewestFirst.filter(
        (job) => !prunable.some((candidate) => candidate.jobId === job.jobId),
    );
    const retainedFailure = retainedJobs.find((job) => job.jobId === protectedJob.jobId);
    assert.ok(retainedFailure, "failed job evidence remains available for later recovery");
    assert.equal(
        failedOwnerCanRelease(file, retainedFailure, { preserveOutputPath: true }),
        true,
        "retained job still proves the delayed cleanup release gate",
    );

    assert.equal(
        selectPrunableFinished(finishedNewestFirst, [{ adjacentJournal: { jobId: protectedJob.jobId } }], 0).some(
            (job) => job.jobId === protectedJob.jobId,
        ),
        false,
        "journal-only ownership also protects its terminal job",
    );
    assert.equal(
        selectPrunableFinished(finishedNewestFirst, [{ activeProbeJobId: protectedJob.jobId }], 0).some(
            (job) => job.jobId === protectedJob.jobId,
        ),
        false,
        "probe ownership protects its terminal job until recovery clears it",
    );
});

test("failed ownership survives every pre-durability crash window and releases only at the terminal gate", () => {
    const job = { jobId: "failure-job", status: JOB_STATUS.failed };
    const base = {
        fileId: "failure-file",
        activeJobId: job.jobId,
        activeSettingId: "setting-a",
        activePhase: "committing",
        status: FILE_STATUS.failed,
        currentOutputPath: "/media/.failure.partial",
        adjacentJournal: { jobId: job.jobId, phase: "prepared" },
        transcodeResults: [],
    };

    assert.equal(failedOwnerCanRelease(base, { ...job, status: JOB_STATUS.running }), false, "job must be failed");
    assert.equal(failedOwnerCanRelease(base, job), false, "failed result must be durable");
    const withResult = {
        ...base,
        transcodeResults: [{ settingId: "setting-a", status: RESULT_STATUS.failed }],
    };
    assert.equal(failedOwnerCanRelease(withResult, job), false, "unsettled cleanup journal retains ownership");
    assert.equal(
        failedOwnerCanRelease(withResult, job, { preserveOutputPath: true }),
        true,
        "explicit retained cleanup ownership is a durable terminal state",
    );
    assert.equal(
        failedOwnerCanRelease({ ...withResult, adjacentJournal: null }, job, { preserveOutputPath: true }),
        false,
        "a bare leftover path without a matching cleanup journal cannot release",
    );
    assert.equal(
        failedOwnerCanRelease({ ...withResult, adjacentJournal: null, currentOutputPath: null }, job),
        true,
        "fully cleaned failure can release",
    );
    assert.equal(
        failedOwnerCanRelease({ ...withResult, status: FILE_STATUS.processing, adjacentJournal: null }, job),
        false,
        "aggregate state must be persisted before release",
    );
});

test("failure commit fences Stop and requeue until old-generation writes are finished", async () => {
    let file = {
        fileId: "failure-interleave",
        status: FILE_STATUS.processing,
        activeJobId: "old-job",
        activeSettingId: "old-setting",
        activePhase: "processing",
        transcodeResults: [],
    };
    await updateFileLifecycle(
        file.fileId,
        (current) => ({ ...current, activePhase: "committing" }),
        async (_collection, _id, updateFn) => {
            file = updateFn(file);
            return file;
        },
    );
    assert.equal(stopFailureForFile(file), "file_finalization_committed");
    assert.equal(hasUnsettledLifecycle(file), true, "requeue remains fenced by the old active owner");

    file = {
        ...file,
        status: FILE_STATUS.failed,
        activeJobId: null,
        activeSettingId: null,
        activePhase: null,
        transcodeResults: [{ settingId: "old-setting", status: RESULT_STATUS.failed }],
    };
    file = { ...file, status: FILE_STATUS.pending, activeProbeJobId: "new-probe" };
    await updateFileLifecycle(
        file.fileId,
        (current) =>
            isOwner(current, "old-job", "old-setting") ? { ...current, errorMessage: "stale old failure" } : current,
        async (_collection, _id, updateFn) => {
            file = updateFn(file);
            return file;
        },
    );
    assert.equal(file.activeProbeJobId, "new-probe");
    assert.equal(file.errorMessage, undefined, "released old generation cannot corrupt immediate requeue");
});

test("terminal ownership cannot release before result, job, aggregate, and journal are durable", () => {
    const file = {
        fileId: "file",
        status: FILE_STATUS.transcoded,
        activeJobId: "job",
        activeSettingId: "setting",
        activePhase: "committing",
        adjacentJournal: { phase: "cleaned" },
        transcodeResults: [{ settingId: "setting", status: RESULT_STATUS.done }],
    };
    const doneJob = { jobId: "job", status: JOB_STATUS.done };
    assert.equal(terminalOwnerCanRelease(file, doneJob), true);
    assert.equal(terminalOwnerCanRelease({ ...file, status: FILE_STATUS.processing }, doneJob), false);
    assert.equal(terminalOwnerCanRelease({ ...file, transcodeResults: [] }, doneJob), false);
    assert.equal(terminalOwnerCanRelease({ ...file, adjacentJournal: { phase: "committed" } }, doneJob), false);
    assert.equal(terminalOwnerCanRelease(file, { ...doneJob, status: JOB_STATUS.running }), false);
});

test("committing ownership reports stop as too late even after aggregate status becomes terminal", () => {
    assert.equal(
        stopFailureForFile({ status: FILE_STATUS.transcoded, activeJobId: "job", activePhase: "committing" }),
        "file_finalization_committed",
    );
});

test("destructive actions recognize stopped owners and unfinished journals as unsettled", () => {
    assert.equal(hasUnsettledLifecycle({ status: FILE_STATUS.stopped, activeJobId: "job" }), true);
    assert.equal(hasUnsettledLifecycle({ status: FILE_STATUS.pending, activeProbeJobId: "probe" }), true);
    assert.equal(hasUnsettledLifecycle({ status: FILE_STATUS.stopped, adjacentJournal: { phase: "cleaned" } }), true);
    assert.equal(
        hasUnsettledLifecycle({ status: FILE_STATUS.stopped, overwriteJournal: { phase: "committed" } }),
        true,
    );
    assert.equal(hasUnsettledLifecycle({ status: FILE_STATUS.stopped }), false);
});

test("probe publication persists ownership and job before wakeup", async () => {
    const order = [];
    let owner = null;
    let created = false;
    const probeJobId = await publishProbeJob("file", {
        reserveId: () => "probe-job",
        publishOwner: async (jobId) => {
            order.push("owner");
            owner = jobId;
            return true;
        },
        createPending: async (jobId) => {
            order.push("job");
            assert.equal(owner, jobId, "owner is durable before the pending job is visible");
            created = true;
        },
        clearOwner: async () => assert.fail("successful publication must not clear ownership"),
        wakeup: () => {
            order.push("wake");
            assert.equal(owner, "probe-job");
            assert.equal(created, true, "queue cannot wake before job persistence completes");
        },
    });

    assert.equal(probeJobId, "probe-job");
    assert.deepEqual(order, ["owner", "job", "wake"]);
});

test("failed probe job persistence conditionally clears the published owner without waking", async () => {
    const order = [];
    let owner = null;
    await assert.rejects(
        publishProbeJob("file", {
            reserveId: () => "probe-job",
            publishOwner: async (jobId) => {
                order.push("owner");
                owner = jobId;
                return true;
            },
            createPending: async () => {
                order.push("job");
                throw new Error("database unavailable");
            },
            clearOwner: async (jobId) => {
                order.push("clear");
                if (owner === jobId) owner = null;
            },
            wakeup: () => assert.fail("failed job persistence must not wake the queue"),
        }),
        /database unavailable/,
    );
    assert.equal(owner, null);
    assert.deepEqual(order, ["owner", "job", "clear"]);
});
