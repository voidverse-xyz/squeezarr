import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchTranscodes } from "../services/event.js";
import { resetTranscode, settleUnassignedTranscodeJob } from "../services/event/dispatch.js";
import { JOB_TYPE, JOB_STATUS, FILE_STATUS } from "shared/domain.js";

// Fakes that record what dispatchTranscodes does. By default every job claims as a TRANSCODE_FILE
// whose payload carries a fileId, prepare yields a runnable command, and assign succeeds.
function makeDeps({
    idle = 99,
    isPaused,
    claimReturns,
    prepareReturns,
    assignReturns,
    getFile,
    validatePrepared,
    resetReturns,
} = {}) {
    const claims = [];
    const completed = [];
    const prepared = [];
    const assigned = [];
    const resets = [];
    const failed = [];
    const released = [];
    return {
        // recording surfaces
        claims,
        completed,
        prepared,
        assigned,
        resets,
        failed,
        released,
        // injected collaborators
        idleRunnerCount: () => idle,
        isPaused: isPaused || (async () => false),
        getFile: getFile || (async () => ({ activeJobId: null })),
        validatePrepared: validatePrepared || (async () => true),
        job: {
            async claim(id) {
                claims.push(id);
                return claimReturns
                    ? claimReturns(id)
                    : { jobId: id, type: JOB_TYPE.TRANSCODE_FILE, payload: { fileId: `f-${id}` } };
            },
            async releaseClaim(id) {
                released.push(id);
            },
            async complete(id) {
                completed.push(id);
            },
            async fail(id, error) {
                failed.push({ jobId: id, error });
            },
        },
        async prepare(job) {
            prepared.push(job.jobId);
            return prepareReturns
                ? prepareReturns(job)
                : { fileId: job.payload.fileId, executable: "ffmpeg", args: [] };
        },
        async assign(jobId, info) {
            assigned.push({ jobId, info });
            return assignReturns ? assignReturns(jobId) : true;
        },
        async reset(jobId, fileId) {
            resets.push({ jobId, fileId });
            return typeof resetReturns === "function" ? resetReturns(jobId, fileId) : resetReturns;
        },
    };
}

const ids = (jobIds) => jobIds.map((jobId) => ({ jobId }));

async function runReset({ job, file, fileId = file?.fileId } = {}) {
    let currentJob = job;
    let currentFile = file;
    const disposition = await resetTranscode(job.jobId, fileId, {
        updateJob: async (updateFn) => {
            currentJob = await updateFn(currentJob);
            return currentJob;
        },
        updateFileLifecycle: async (updateFn) => {
            currentFile = await updateFn(currentFile);
            return currentFile;
        },
    });
    return { disposition, job: currentJob, file: currentFile };
}

const ownedFile = (status = FILE_STATUS.processing) => ({
    fileId: "reset-file",
    status,
    activeJobId: "reset-job",
    activeSettingId: "setting",
    activePhase: "processing",
    currentOutputPath: "/data/.reset.partial",
    cancelled: false,
});

const resetJob = (status = JOB_STATUS.running) => ({
    jobId: "reset-job",
    status,
    startedAt: 1,
    lifecyclePhase: "prepared",
});

test("reset moves a matching running job and owner back to pending/queued", async () => {
    const result = await runReset({ job: resetJob(), file: ownedFile() });

    assert.equal(result.disposition, "reset");
    assert.equal(result.job.status, JOB_STATUS.pending);
    assert.equal(result.file.status, FILE_STATUS.queued);
    assert.equal(result.file.activeJobId, null);
});

test("reset terminally settles a stopped running generation and clears only its owner", async () => {
    const result = await runReset({ job: resetJob(), file: { ...ownedFile(FILE_STATUS.stopped), cancelled: true } });

    assert.equal(result.disposition, "stopped");
    assert.equal(result.job.status, JOB_STATUS.failed);
    assert.match(result.job.error, /Stopped before runner assignment/);
    assert.equal(result.file.status, FILE_STATUS.stopped);
    assert.equal(result.file.activeJobId, null);
    assert.equal(result.file.cancelled, false);
});

test("reset terminally settles a running job whose file is missing", async () => {
    const result = await runReset({ job: resetJob(), file: null, fileId: "missing-file" });

    assert.equal(result.disposition, "missing");
    assert.equal(result.job.status, JOB_STATUS.failed);
    assert.match(result.job.error, /File removed/);
    assert.equal(result.file, null);
});

test("reset preserves a done job and its file owner for authoritative finalization", async () => {
    const file = ownedFile();
    const result = await runReset({ job: resetJob(JOB_STATUS.done), file });

    assert.equal(result.disposition, "stale");
    assert.equal(result.job.status, JOB_STATUS.done);
    assert.equal(result.file.activeJobId, "reset-job");
    assert.equal(result.file, file);
});

test("reset preserves a failed job and its file owner for startup recovery", async () => {
    const file = ownedFile(FILE_STATUS.failed);
    const result = await runReset({ job: resetJob(JOB_STATUS.failed), file });

    assert.equal(result.disposition, "stale");
    assert.equal(result.job.status, JOB_STATUS.failed);
    assert.equal(result.file.activeJobId, "reset-job");
    assert.equal(result.file, file);
});

test("reset without a file ID reports stale unless running moved to pending", async () => {
    const done = await runReset({ job: resetJob(JOB_STATUS.done), file: null, fileId: null });
    const running = await runReset({ job: resetJob(), file: null, fileId: null });

    assert.equal(done.disposition, "stale");
    assert.equal(done.job.status, JOB_STATUS.done);
    assert.equal(running.disposition, "reset");
    assert.equal(running.job.status, JOB_STATUS.pending);
});

test("assigns one transcode per idle runner, then saturates", async () => {
    const deps = makeDeps({ idle: 2 });

    const result = await dispatchTranscodes(ids(["a", "b", "c"]), deps);

    assert.equal(result, "saturated");
    assert.deepEqual(deps.claims, ["a", "b"], "only claims up to capacity");
    assert.deepEqual(
        deps.assigned.map((a) => a.jobId),
        ["a", "b"],
    );
});

test("assigns every transcode when capacity is sufficient", async () => {
    const deps = makeDeps({ idle: 5 });

    const result = await dispatchTranscodes(ids(["a", "b"]), deps);

    assert.equal(result, "drained");
    assert.deepEqual(
        deps.assigned.map((a) => a.jobId),
        ["a", "b"],
    );
});

test("assigns nothing when there are no idle runners", async () => {
    const deps = makeDeps({ idle: 0 });

    const result = await dispatchTranscodes(ids(["a"]), deps);

    assert.equal(result, "saturated");
    assert.deepEqual(deps.claims, []);
    assert.deepEqual(deps.assigned, []);
});

test("does not assign any transcode when already paused", async () => {
    const deps = makeDeps({ idle: 5, isPaused: async () => true });

    const result = await dispatchTranscodes(ids(["a", "b"]), deps);

    assert.equal(result, "paused");
    assert.deepEqual(deps.claims, []);
});

// The regression mirror of the inline-queue pause test: a pause landing mid-pass withholds the
// next assignment (the one already handed off keeps running on its runner).
test("pausing mid-pass assigns no further transcodes", async () => {
    let paused = false;
    const deps = makeDeps({
        idle: 5,
        isPaused: async () => paused,
        assignReturns: () => {
            paused = true; // user hits pause right after the first hand-off
            return true;
        },
    });

    const result = await dispatchTranscodes(ids(["a", "b", "c"]), deps);

    assert.equal(result, "paused");
    assert.deepEqual(deps.claims, ["a"], "only the first job is claimed");
    assert.deepEqual(
        deps.assigned.map((a) => a.jobId),
        ["a"],
    );
});

test("completes (does not assign) a job with nothing to run", async () => {
    const deps = makeDeps({
        idle: 5,
        prepareReturns: (job) =>
            job.jobId === "a" ? null : { fileId: job.payload.fileId, executable: "ffmpeg", args: [] },
    });

    const result = await dispatchTranscodes(ids(["a", "b"]), deps);

    assert.equal(result, "drained");
    assert.deepEqual(deps.completed, ["a"], "the skipped job is completed");
    assert.deepEqual(
        deps.assigned.map((a) => a.jobId),
        ["b"],
    );
});

test("owned files return saturated so the queue waits for runner-result wakeup", async () => {
    const deps = makeDeps({ getFile: async () => ({ activeJobId: "active-job" }) });
    const result = await dispatchTranscodes([{ jobId: "sibling", payload: { fileId: "same" } }], deps);

    assert.equal(result, "saturated");
    assert.deepEqual(deps.claims, []);
    assert.deepEqual(deps.assigned, []);
});

test("same-pass sibling remains pending and makes the dispatch pass wait", async () => {
    const pending = [
        { jobId: "high", payload: { fileId: "same" } },
        { jobId: "low", payload: { fileId: "same" } },
    ];
    const deps = makeDeps({
        claimReturns: (jobId) => ({
            jobId,
            type: JOB_TYPE.TRANSCODE_FILE,
            payload: { fileId: "same" },
        }),
    });
    const result = await dispatchTranscodes(pending, deps);

    assert.equal(result, "saturated");
    assert.deepEqual(deps.claims, ["high"]);
    assert.deepEqual(
        deps.assigned.map(({ jobId }) => jobId),
        ["high"],
    );
});

test("a conditionally deferred preparation returns saturated after resetting the claim", async () => {
    const deps = makeDeps({
        prepareReturns: () => ({ deferred: true, fileId: "same" }),
    });
    const result = await dispatchTranscodes(ids(["deferred"]), deps);

    assert.equal(result, "saturated");
    assert.deepEqual(deps.resets, [{ jobId: "deferred", fileId: "same" }]);
});

test("revalidates durable ownership immediately before assignment", async () => {
    const deps = makeDeps({
        validatePrepared: async () => false,
        resetReturns: "stopped",
    });
    const result = await dispatchTranscodes(ids(["stopped-before-assign"]), deps);

    assert.equal(result, "drained");
    assert.deepEqual(deps.resets, [{ jobId: "stopped-before-assign", fileId: "f-stopped-before-assign" }]);
    assert.deepEqual(deps.assigned, []);
});

test("reverts the claim when no runner takes the job", async () => {
    const deps = makeDeps({ idle: 1, assignReturns: () => false });

    const result = await dispatchTranscodes(ids(["a"]), deps);

    assert.equal(result, "saturated");
    assert.deepEqual(deps.resets, [{ jobId: "a", fileId: "f-a" }], "the job/file are reset for a retry");
});

test("stop during async pre-claim prepare terminally settles the claimed generation", async () => {
    let file = { fileId: "f-a", status: FILE_STATUS.queued, activeJobId: null, cancelled: false };
    let claimedJob = { jobId: "a", status: JOB_STATUS.running };
    let releasePrepare;
    let prepareEntered;
    const entered = new Promise((resolve) => {
        prepareEntered = resolve;
    });
    const canFinish = new Promise((resolve) => {
        releasePrepare = resolve;
    });
    const deps = makeDeps({
        getFile: async () => file,
        prepareReturns: async () => {
            prepareEntered();
            await canFinish;
            return { deferred: true, fileId: file.fileId };
        },
        resetReturns: () => {
            claimedJob = settleUnassignedTranscodeJob(claimedJob, file, "a");
            return "stopped";
        },
    });

    const dispatch = dispatchTranscodes(ids(["a"]), deps);
    await entered;
    // Stop wins the lifecycle section before prepare publishes activeJobId.
    file = { ...file, status: FILE_STATUS.stopped };
    releasePrepare();
    await dispatch;

    assert.equal(file.activeJobId, null, "the generation never acquired file ownership");
    assert.equal(claimedJob.status, JOB_STATUS.failed);
    assert.match(claimedJob.error, /Stopped before runner assignment/);
    assert.deepEqual(deps.assigned, []);

    const unrelatedOwner = { ...file, activeJobId: "other-job" };
    const fenced = settleUnassignedTranscodeJob({ jobId: "a", status: JOB_STATUS.running }, unrelatedOwner, "a");
    assert.equal(fenced.status, JOB_STATUS.failed, "stop still settles this unowned claimed generation");
    assert.equal(unrelatedOwner.activeJobId, "other-job", "an unrelated active owner is never mutated");
    const unrelatedActive = { ...unrelatedOwner, status: FILE_STATUS.processing };
    assert.equal(
        settleUnassignedTranscodeJob({ jobId: "a", status: JOB_STATUS.running }, unrelatedActive, "a").status,
        JOB_STATUS.running,
        "without Stop, reset cannot mutate a job blocked by an unrelated owner",
    );
});

test("shutdown at the file lookup boundary claims and prepares nothing", async () => {
    let running = true;
    const deps = makeDeps({
        getFile: async () => {
            running = false;
            return { activeJobId: null };
        },
    });
    deps.isRunning = () => running;

    assert.equal(await dispatchTranscodes([{ jobId: "lookup", payload: { fileId: "file" } }], deps), "stopped");
    assert.deepEqual(deps.claims, []);
    assert.deepEqual(deps.assigned, []);
});

test("shutdown at the claim boundary releases the unstarted claim", async () => {
    let running = true;
    const deps = makeDeps({
        claimReturns: (jobId) => {
            running = false;
            return { jobId, type: JOB_TYPE.TRANSCODE_FILE, payload: { fileId: "file" } };
        },
    });
    deps.isRunning = () => running;

    assert.equal(await dispatchTranscodes(ids(["claim"]), deps), "stopped");
    assert.deepEqual(deps.released, ["claim"]);
    assert.deepEqual(deps.prepared, []);
});

test("shutdown at prepare and validation boundaries resets ownership before returning", async () => {
    for (const boundary of ["prepare", "validate"]) {
        let running = true;
        const deps = makeDeps({
            prepareReturns: (job) => {
                if (boundary === "prepare") running = false;
                return { fileId: job.payload.fileId, executable: "ffmpeg", args: [] };
            },
            validatePrepared: async () => {
                if (boundary === "validate") running = false;
                return true;
            },
        });
        deps.isRunning = () => running;

        assert.equal(await dispatchTranscodes(ids([boundary]), deps), "stopped");
        assert.deepEqual(deps.resets, [{ jobId: boundary, fileId: `f-${boundary}` }]);
        assert.deepEqual(deps.assigned, []);
    }
});

test("shutdown reset failure rejects the transcode drain", async (t) => {
    t.mock.method(console, "error", () => {});
    let running = true;
    const deps = makeDeps({
        prepareReturns: (job) => {
            running = false;
            return { fileId: job.payload.fileId, executable: "ffmpeg", args: [] };
        },
    });
    deps.isRunning = () => running;
    let resetCalls = 0;
    deps.reset = async () => {
        resetCalls += 1;
        if (resetCalls === 1) throw new Error("reset persistence failed");
    };

    await assert.rejects(dispatchTranscodes(ids(["reset"]), deps), /reset persistence failed/);
    assert.equal(resetCalls, 2, "cleanup retries but retains the first rollback error");
});

test("non-shutdown transcode cleanup rejections retain prepare, reset, and failure errors", async (t) => {
    t.mock.method(console, "error", () => {});
    const deps = makeDeps({
        prepareReturns: () => {
            throw new Error("prepare failed");
        },
    });
    deps.reset = async () => {
        throw new Error("reset persistence failed");
    };
    deps.job.fail = async () => {
        throw new Error("failure persistence failed");
    };

    await assert.rejects(dispatchTranscodes(ids(["cleanup"]), deps), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
            error.errors.map(({ message }) => message),
            ["prepare failed", "reset persistence failed", "failure persistence failed"],
        );
        return true;
    });
});

test("a throwing transcode prepare fails that job and continues dispatching", async () => {
    const deps = makeDeps({
        idle: 5,
        prepareReturns: (job) => {
            if (job.jobId === "a") {
                throw new Error("prepare exploded");
            }
            return { fileId: job.payload.fileId, executable: "ffmpeg", args: [] };
        },
    });

    const result = await dispatchTranscodes(ids(["a", "b"]), deps);

    assert.equal(result, "drained");
    assert.deepEqual(deps.resets, [{ jobId: "a", fileId: "f-a" }]);
    assert.deepEqual(deps.failed, [{ jobId: "a", error: "prepare exploded" }]);
    assert.deepEqual(
        deps.assigned.map((a) => a.jobId),
        ["b"],
    );
});
