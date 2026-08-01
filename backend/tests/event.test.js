import { test } from "node:test";
import assert from "node:assert/strict";
import { getState, initialize, runPendingJobs, shutdown } from "../services/event.js";
import { JOB_TYPE } from "shared/domain.js";

// A fake job store that records what runPendingJobs does to it. `claimReturns(id)` lets a
// test control what claim() resolves to (e.g. null for an already-claimed job, or a custom
// job type); by default every job claims as a TRANSCODE_FILE.
function makeJob({ claimReturns } = {}) {
    const claims = [];
    const completed = [];
    const failed = [];
    const released = [];
    return {
        claims,
        completed,
        failed,
        released,
        async claim(id) {
            claims.push(id);
            return claimReturns ? claimReturns(id) : { jobId: id, type: JOB_TYPE.TRANSCODE_FILE, payload: {} };
        },
        async releaseClaim(id) {
            released.push(id);
        },
        async complete(id) {
            completed.push(id);
        },
        async fail(id, error) {
            failed.push({ id, error });
        },
    };
}

const notPaused = async () => ({ processingPaused: false });
const alwaysRunning = () => true;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

test("runs and completes every job when not paused", async () => {
    const ran = [];
    const job = makeJob();
    const handlers = { [JOB_TYPE.TRANSCODE_FILE]: async (j) => ran.push(j.jobId) };

    const result = await runPendingJobs([{ jobId: "a" }, { jobId: "b" }, { jobId: "c" }], {
        handlers,
        job,
        getSettings: notPaused,
        isRunning: alwaysRunning,
    });

    assert.equal(result, "drained");
    assert.deepEqual(job.claims, ["a", "b", "c"]);
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.deepEqual(job.completed, ["a", "b", "c"]);
});

// The regression: pausing while a batch is mid-flight must stop NEW jobs, while the job
// already running is allowed to finish.
test("pausing mid-batch finishes the running job but starts no new ones", async () => {
    const ran = [];
    let paused = false;
    const job = makeJob();
    const handlers = {
        [JOB_TYPE.TRANSCODE_FILE]: async (j) => {
            ran.push(j.jobId);
            paused = true; // user hits pause while the first job is transcoding
        },
    };

    const result = await runPendingJobs([{ jobId: "a" }, { jobId: "b" }, { jobId: "c" }], {
        handlers,
        job,
        getSettings: async () => ({ processingPaused: paused }),
        isRunning: alwaysRunning,
    });

    assert.equal(result, "paused");
    assert.deepEqual(job.claims, ["a"], "only the first job is claimed");
    assert.deepEqual(ran, ["a"], "no new job starts after the pause");
    assert.deepEqual(job.completed, ["a"], "the in-flight job still completes");
});

test("does not start any job when already paused", async () => {
    const job = makeJob();
    const handlers = { [JOB_TYPE.TRANSCODE_FILE]: async () => {} };

    const result = await runPendingJobs([{ jobId: "a" }, { jobId: "b" }], {
        handlers,
        job,
        getSettings: async () => ({ processingPaused: true }),
        isRunning: alwaysRunning,
    });

    assert.equal(result, "paused");
    assert.deepEqual(job.claims, []);
});

test("stops claiming once the loop is no longer running", async () => {
    const job = makeJob();
    const result = await runPendingJobs([{ jobId: "a" }], {
        handlers: {},
        job,
        getSettings: notPaused,
        isRunning: () => false,
    });

    assert.equal(result, "stopped");
    assert.deepEqual(job.claims, []);
});

test("shutdown while an inline claim is pending releases it without starting the handler", async () => {
    let running = true;
    const job = makeJob({
        claimReturns: (id) => {
            running = false;
            return { jobId: id, type: JOB_TYPE.TRANSCODE_FILE, payload: {} };
        },
    });
    let handled = false;
    const result = await runPendingJobs([{ jobId: "boundary" }], {
        handlers: { [JOB_TYPE.TRANSCODE_FILE]: async () => (handled = true) },
        job,
        getSettings: notPaused,
        isRunning: () => running,
    });

    assert.equal(result, "stopped");
    assert.deepEqual(job.released, ["boundary"]);
    assert.equal(handled, false);
});

test("a releaseClaim failure rejects the inline queue drain", async (t) => {
    t.mock.method(console, "error", () => {});
    let running = true;
    const job = makeJob({
        claimReturns: (id) => {
            running = false;
            return { jobId: id, type: JOB_TYPE.TRANSCODE_FILE, payload: {} };
        },
    });
    job.releaseClaim = async () => {
        throw new Error("release persistence failed");
    };

    await assert.rejects(
        runPendingJobs([{ jobId: "boundary" }], {
            handlers: {},
            job,
            getSettings: notPaused,
            isRunning: () => running,
        }),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(
                error.errors.map(({ message }) => message),
                ["release persistence failed"],
            );
            return true;
        },
    );
});

test("handler/completion and failure-persistence rejections are retained in an AggregateError", async (t) => {
    t.mock.method(console, "error", () => {});
    for (const stage of ["handler", "completion"]) {
        const job = makeJob();
        job.fail = async () => {
            throw new Error("failure persistence failed");
        };
        if (stage === "completion") {
            job.complete = async () => {
                throw new Error("completion failed");
            };
        }

        await assert.rejects(
            runPendingJobs([{ jobId: stage }], {
                handlers: {
                    [JOB_TYPE.TRANSCODE_FILE]: async () => {
                        if (stage === "handler") throw new Error("handler failed");
                    },
                },
                job,
                getSettings: notPaused,
                isRunning: alwaysRunning,
            }),
            (error) => {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(
                    error.errors.map(({ message }) => message),
                    [`${stage} failed`, "failure persistence failed"],
                );
                return true;
            },
        );
    }
});

test("skips a job that can no longer be claimed", async () => {
    const ran = [];
    const job = makeJob({ claimReturns: () => null });
    const handlers = { [JOB_TYPE.TRANSCODE_FILE]: async (j) => ran.push(j.jobId) };

    const result = await runPendingJobs([{ jobId: "a" }], {
        handlers,
        job,
        getSettings: notPaused,
        isRunning: alwaysRunning,
    });

    assert.equal(result, "drained");
    assert.deepEqual(ran, []);
    assert.deepEqual(job.completed, []);
});

test("fails a job whose type has no registered handler", async () => {
    const job = makeJob({ claimReturns: (id) => ({ jobId: id, type: "UNKNOWN_TYPE", payload: {} }) });

    const result = await runPendingJobs([{ jobId: "a" }], {
        handlers: {},
        job,
        getSettings: notPaused,
        isRunning: alwaysRunning,
    });

    assert.equal(result, "drained");
    assert.equal(job.failed.length, 1);
    assert.match(job.failed[0].error, /No handler registered/);
});

test("shutdown during queue recovery cannot revive or start the loop", async () => {
    let releaseRecovery;
    let recoveryEntered;
    const entered = new Promise((resolve) => {
        recoveryEntered = resolve;
    });
    const canRecover = new Promise((resolve) => {
        releaseRecovery = resolve;
    });
    let loopCalls = 0;
    const starting = initialize({
        recover: async () => {
            recoveryEntered();
            await canRecover;
        },
        loop: async () => {
            loopCalls++;
        },
        onFatal: assert.fail,
    });
    await entered;
    const draining = shutdown();
    releaseRecovery();
    await Promise.all([starting, draining]);

    assert.equal(loopCalls, 0);
    assert.equal(getState().status, "stopped");
});

test("queue shutdown returns a rejecting drain when shutdown rollback fails", async (t) => {
    t.mock.method(console, "error", () => {});
    let rejectLoop;
    await initialize({
        recover: async () => {},
        loop: () =>
            new Promise((_resolve, reject) => {
                rejectLoop = reject;
            }),
        onFatal: assert.fail,
    });
    const drain = shutdown();
    rejectLoop(new Error("rollback failed"));
    await assert.rejects(drain, /rollback failed/);
    assert.equal(getState().status, "crashed");
});

test("SIGTERM while inline failure persistence is pending rejects the supervised queue drain", async (t) => {
    t.mock.method(console, "error", () => {});
    const failureEntered = deferred();
    const failurePersistence = deferred();
    const job = makeJob();
    job.fail = async () => {
        failureEntered.resolve();
        await failurePersistence.promise;
    };

    await initialize({
        recover: async () => {},
        loop: () =>
            runPendingJobs([{ jobId: "inline" }], {
                handlers: {
                    [JOB_TYPE.TRANSCODE_FILE]: async () => {
                        throw new Error("inline handler failed");
                    },
                },
                job,
                getSettings: notPaused,
                isRunning: () => getState().ready,
            }),
        onFatal: assert.fail,
    });
    await failureEntered.promise;

    const drain = shutdown();
    failurePersistence.reject(new Error("inline failure persistence rejected"));
    await assert.rejects(drain, (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
            error.errors.map(({ message }) => message),
            ["inline handler failed", "inline failure persistence rejected"],
        );
        return true;
    });
    assert.equal(getState().status, "crashed");
});

test("a top-level queue crash is observable and initialize can recover lifecycle state", async (t) => {
    t.mock.method(console, "error", () => {});
    let fatalError = null;
    await initialize({
        recover: async () => {},
        loop: async () => {
            throw new Error("database unavailable");
        },
        onFatal: (error) => {
            fatalError = error;
        },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(getState().ready, false);
    assert.equal(getState().status, "crashed");
    assert.match(fatalError.message, /database unavailable/);

    let releaseLoop;
    await initialize({
        recover: async () => {},
        loop: () =>
            new Promise((resolve) => {
                releaseLoop = resolve;
            }),
        onFatal: assert.fail,
    });
    assert.equal(getState().ready, true);
    assert.equal(getState().status, "running");

    shutdown();
    releaseLoop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getState().status, "stopped");
});

test("a throwing handler fails that job and the batch continues", async (t) => {
    t.mock.method(console, "error", () => {}); // the handler error is logged on purpose; hush it
    const job = makeJob();
    const handlers = {
        [JOB_TYPE.TRANSCODE_FILE]: async (j) => {
            if (j.jobId === "a") {
                throw new Error("boom");
            }
        },
    };

    const result = await runPendingJobs([{ jobId: "a" }, { jobId: "b" }], {
        handlers,
        job,
        getSettings: notPaused,
        isRunning: alwaysRunning,
    });

    assert.equal(result, "drained");
    assert.deepEqual(job.claims, ["a", "b"]);
    assert.equal(job.failed.length, 1);
    assert.deepEqual(job.completed, ["b"]);
});
