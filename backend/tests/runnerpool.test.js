import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import * as registry from "../services/runnerpool/registry.js";
import * as readiness from "../services/readiness.js";
import {
    attach,
    drainSocket,
    evictStaleRunners,
    handleClose,
    serializeSocketEvent,
    shutdown as shutdownPool,
} from "../services/runnerpool/server.js";
import {
    createLostWorkRecovery,
    fileBelongsToJob,
    outputPathForLostJob,
    retiredPathsForLostJob,
} from "../services/runnerpool/recovery.js";
import { assign } from "../services/runnerpool/commands.js";
import { handleResult } from "../services/runnerpool/inbound.js";
import { RUNNER_HEARTBEAT_TIMEOUT_MS } from "../utilities/constants.js";
import { FILE_STATUS } from "shared/domain.js";

afterEach(() => {
    registry.clear();
    registry.startAccepting();
});

function fakeSocket() {
    return {
        readyState: WebSocket.OPEN,
        terminated: 0,
        terminate() {
            this.terminated += 1;
        },
    };
}

function registerBusy({ runnerId = "runner-1", jobId = "job-1", assignmentId = "lease-1" } = {}) {
    const ws = fakeSocket();
    const runner = registry.register(ws, { runnerId, host: "runner", info: null });
    registry.markBusy(runner, { jobId, assignmentId, fileId: "file-1", currentFile: null });
    return { ws, runner };
}

test("runner registry publishes every processing-capacity transition", () => {
    readiness.reset();
    const first = registerBusy();
    assert.deepEqual(readiness.getReadiness().capacity.processing, {
        connected: 1,
        idle: 0,
        busy: 1,
        paused: 0,
        accepting: 0,
    });

    assert.equal(registry.claimResult(first.ws, "job-1", "lease-1"), first.runner);
    assert.equal(registry.markIdle(first.runner, "lease-1"), true);
    assert.equal(readiness.getReadiness().capacity.processing.accepting, 1);
    registry.setPaused("runner-1", true);
    assert.deepEqual(readiness.getReadiness().capacity.processing, {
        connected: 1,
        idle: 1,
        busy: 0,
        paused: 1,
        accepting: 0,
    });
    registry.remove("runner-1", first.ws);
    assert.equal(readiness.getReadiness().subsystems.processing, "no_runners");
});

test("per-socket serialization waits for result finalization before close recovery", async () => {
    const ws = fakeSocket();
    const events = [];
    let releaseFinalization;
    const finalization = new Promise((resolve) => {
        releaseFinalization = resolve;
    });

    const result = serializeSocketEvent(ws, async () => {
        events.push("result-start");
        await finalization;
        events.push("result-done");
    });
    const close = serializeSocketEvent(ws, async () => events.push("close"));

    await Promise.resolve();
    assert.deepEqual(events, ["result-start"]);
    releaseFinalization();
    await Promise.all([result, close]);
    assert.deepEqual(events, ["result-start", "result-done", "close"]);
});

test("a rejected message does not prevent the serialized close handler", async () => {
    const ws = fakeSocket();
    const errors = [];
    const events = [];
    await serializeSocketEvent(
        ws,
        async () => {
            throw new Error("bad frame");
        },
        (error) => errors.push(error.message),
    );
    await serializeSocketEvent(ws, async () => events.push("close"));
    assert.deepEqual(errors, ["bad frame"]);
    assert.deepEqual(events, ["close"]);
});

test("runner close recovery failure remains attached to the socket drain", async () => {
    const { ws } = registerBusy();
    await serializeSocketEvent(ws, () =>
        handleClose(ws, {
            recover: async () => {
                throw new Error("requeue persistence failed");
            },
        }),
    );
    ws.readyState = WebSocket.CLOSED;

    await assert.rejects(drainSocket(ws), /runner socket event drain failed/);
    assert.match(ws.runnerEventErrors[0].message, /requeue persistence failed/);
});

test("runner finalization failure remains attached after stable job failure and idle transition", async () => {
    const { ws, runner } = registerBusy();
    await serializeSocketEvent(ws, () =>
        handleResult(
            ws,
            { taskId: "job-1", assignmentId: "lease-1", exitCode: 1, cancelled: false },
            {
                jobs: {
                    get: async () => ({ jobId: "job-1", status: "running" }),
                    failIfActive: async () => true,
                },
                ffmpeg: {
                    finalizeTranscode: async () => {
                        throw new Error("finalization failed");
                    },
                },
            },
        ),
    );
    ws.readyState = WebSocket.CLOSED;

    assert.equal(runner.status, "idle", "failure persistence settles before the drain reports the error");
    await assert.rejects(drainSocket(ws), /runner socket event drain failed/);
    assert.match(ws.runnerEventErrors[0].message, /finalization failed/);
});

test("result claim wins over close recovery exactly once", () => {
    const { ws, runner } = registerBusy();
    assert.equal(registry.claimResult(ws, "job-1", "lease-1"), runner);
    assert.equal(registry.claimResult(ws, "job-1", "lease-1"), null);
    assert.equal(registry.claimRecovery(runner), null);
    assert.equal(registry.markIdle(runner, "lease-1"), true);
});

test("close recovery fences a late result and an old close cannot remove a reconnect", () => {
    const { ws: oldWs, runner: oldRunner } = registerBusy();
    assert.deepEqual(registry.claimRecovery(oldRunner), {
        jobId: "job-1",
        fileId: "file-1",
        assignmentId: "lease-1",
    });
    assert.equal(registry.remove("runner-1", oldWs), oldRunner);
    assert.equal(registry.claimResult(oldWs, "job-1", "lease-1"), null);

    const newWs = fakeSocket();
    const replacement = registry.register(newWs, { runnerId: "runner-1", host: "runner", info: null });
    assert.equal(registry.remove("runner-1", oldWs), null);
    assert.equal(registry.get("runner-1"), replacement);
});

test("assignment lease fences an old result after the same job is reassigned", () => {
    const { ws: oldWs, runner: oldRunner } = registerBusy();
    registry.claimRecovery(oldRunner);
    registry.remove("runner-1", oldWs);

    const newWs = fakeSocket();
    const replacement = registry.register(newWs, { runnerId: "runner-2", host: "runner", info: null });
    registry.markBusy(replacement, {
        jobId: "job-1",
        assignmentId: "lease-2",
        fileId: "file-1",
        currentFile: null,
    });

    assert.equal(registry.claimResult(oldWs, "job-1", "lease-1"), null);
    assert.equal(registry.claimResult(newWs, "job-1", "lease-1"), null);
    assert.equal(registry.claimResult(newWs, "job-1", "lease-2"), replacement);
});

test("disconnect recovery requires the same durable job and prepared output owner", () => {
    const runningJob = { jobId: "job-1", preparedOutputPath: "/data/task-output.mkv" };
    const ownedFile = {
        activeJobId: "job-1",
        status: FILE_STATUS.processing,
        currentOutputPath: "/data/task-output.mkv",
    };
    assert.equal(fileBelongsToJob(ownedFile, "job-1"), true);
    assert.equal(outputPathForLostJob(ownedFile, runningJob), "/data/task-output.mkv");
    assert.equal(fileBelongsToJob({ ...ownedFile, activeJobId: "new-job" }, "job-1"), false);
    assert.equal(outputPathForLostJob({ ...ownedFile, currentOutputPath: "/data/new-output.mkv" }, runningJob), null);
    assert.equal(fileBelongsToJob({ ...ownedFile, status: FILE_STATUS.transcoded }, "job-1"), false);
});

function recoveryHarness(file, job, unlinkFile = async () => {}) {
    const state = { file: structuredClone(file), job: structuredClone(job), logs: [] };
    const database = {
        async get(collection, id) {
            if (collection === "files" && state.file?.fileId === id) {
                return structuredClone(state.file);
            }
            if (collection === "jobs" && state.job?.jobId === id) {
                return structuredClone(state.job);
            }
            return null;
        },
        async update(collection, id, updateFn) {
            const key = collection === "files" ? "file" : "job";
            const updated = await updateFn(structuredClone(state[key]));
            if (updated != null) {
                state[key] = structuredClone(updated);
            }
            return updated;
        },
    };
    const processingService = {
        async transitionOwner(fileId, jobId, patch, { requireActive = false } = {}) {
            if (
                state.file?.fileId !== fileId ||
                state.file.activeJobId !== jobId ||
                (requireActive && (state.file.cancelled || state.file.status === FILE_STATUS.stopped))
            ) {
                return false;
            }
            state.file = { ...state.file, ...structuredClone(patch) };
            return true;
        },
        async getOwnedFile(fileId, jobId) {
            return state.file?.fileId === fileId && state.file.activeJobId === jobId
                ? structuredClone(state.file)
                : null;
        },
    };
    const recover = createLostWorkRecovery({
        database,
        processingService,
        unlinkFile,
        logger: { log: (...args) => state.logs.push(args) },
        now: () => 1234,
    });
    return { state, recover };
}

function activeRecoveryState(mode = "adjacent") {
    const scratchPath = `/data/.movie.${mode}.old-scratch.mkv`;
    const file = {
        fileId: "file-1",
        status: FILE_STATUS.processing,
        cancelled: false,
        activeJobId: "job-1",
        activeSettingId: "setting-1",
        activePhase: "processing",
        currentOutputPath: scratchPath,
        reservedOutputPath: mode === "adjacent" ? "/data/movie.final.mkv" : null,
        processingStartedAt: 100,
        retiredOutputPaths: ["/data/already-retired.mkv"],
        adjacentJournal:
            mode === "adjacent"
                ? {
                      jobId: "job-1",
                      scratchPath,
                      finalPath: "/data/movie.final.mkv",
                      phase: "prepared",
                  }
                : null,
        overwriteJournal:
            mode === "overwrite"
                ? {
                      jobId: "job-1",
                      tempPath: scratchPath,
                      backupPath: "/data/.movie.old-backup.mkv",
                      phase: "prepared",
                  }
                : null,
    };
    const job = {
        jobId: "job-1",
        type: "TRANSCODE_FILE",
        status: "running",
        startedAt: 100,
        progress: "00:00:10.00",
        error: null,
        preparedOutputPath: scratchPath,
        finalOutputPath: mode === "adjacent" ? "/data/movie.final.mkv" : "/data/movie.mkv",
        taskGenerationId: "old-generation",
        outputMode: mode,
        lifecyclePhase: "prepared",
        payload: { fileId: "file-1", settingId: "setting-1" },
    };
    return { file, job, scratchPath };
}

test("runner-loss cleanup cannot overwrite a stop acknowledged while unlink is pending", async () => {
    const { file, job, scratchPath } = activeRecoveryState("adjacent");
    let releaseUnlink;
    let unlinkStarted;
    const started = new Promise((resolve) => {
        unlinkStarted = resolve;
    });
    const { state, recover } = recoveryHarness(file, job, async () => {
        unlinkStarted();
        await new Promise((resolve) => {
            releaseUnlink = resolve;
        });
    });

    const recovery = recover(job.jobId, file.fileId);
    await started;
    // Deterministic equivalent of processing.cancel() completing under its lifecycle lock.
    state.file = { ...state.file, status: FILE_STATUS.stopped, cancelled: true };
    releaseUnlink();

    assert.equal(await recovery, true);
    assert.equal(state.file.status, FILE_STATUS.stopped);
    assert.equal(state.file.cancelled, false);
    assert.equal(state.file.activeJobId, null);
    assert.equal(state.file.currentOutputPath, null);
    assert.equal(state.file.reservedOutputPath, null);
    assert.equal(state.file.adjacentJournal, null);
    assert.ok(state.file.retiredOutputPaths.includes(scratchPath));
    assert.equal(state.job.status, "failed");
});

test("adjacent runner-loss retry fully retires the old generation", async () => {
    const { file, job, scratchPath } = activeRecoveryState("adjacent");
    const { state, recover } = recoveryHarness(file, job);

    assert.equal(await recover(job.jobId, file.fileId), true);
    assert.equal(state.file.status, FILE_STATUS.queued);
    assert.equal(state.file.activeJobId, null);
    assert.equal(state.file.currentOutputPath, null);
    assert.equal(state.file.reservedOutputPath, null);
    assert.equal(state.file.adjacentJournal, null);
    assert.deepEqual(state.file.retiredOutputPaths, ["/data/already-retired.mkv", scratchPath]);
    assert.equal(state.job.status, "pending");
    for (const field of ["preparedOutputPath", "finalOutputPath", "taskGenerationId", "outputMode", "lifecyclePhase"]) {
        assert.equal(state.job[field], null);
    }
});

test("overwrite runner loss tombstones both old temp and backup generations", async () => {
    const { file, job, scratchPath } = activeRecoveryState("overwrite");
    const paths = retiredPathsForLostJob(file, job);
    assert.ok(paths.includes(scratchPath));
    assert.ok(paths.includes(file.overwriteJournal.backupPath));

    const { state, recover } = recoveryHarness(file, job);
    assert.equal(await recover(job.jobId, file.fileId), true);
    assert.equal(state.file.overwriteJournal, null);
    assert.equal(state.file.currentOutputPath, null);
    assert.ok(state.file.retiredOutputPaths.includes(scratchPath));
    assert.ok(state.file.retiredOutputPaths.includes(file.overwriteJournal.backupPath));
    assert.equal(state.job.status, "pending");
});

test("the final assignment gate rejects work after pool acceptance stops", async () => {
    const ws = fakeSocket();
    registry.register(ws, { runnerId: "idle", host: "runner", info: null });
    registry.stopAccepting();

    assert.equal(readiness.getReadiness().capacity.processing.accepting, 0);
    assert.equal(await assign("job", { fileId: "file", executable: "ffmpeg", args: [] }), false);
    assert.equal(registry.get("idle").currentJobId, null);
});

test("pool shutdown clears the registry but rejects when a socket event chain failed", async () => {
    const ws = fakeSocket();
    ws.readyState = WebSocket.CLOSED;
    registry.register(ws, { runnerId: "failed-chain", host: "runner", info: null });
    await serializeSocketEvent(ws, async () => {
        throw new Error("recovery failed");
    });

    await assert.rejects(shutdownPool(), /runner pool shutdown drain failed/);
    assert.equal(registry.get("failed-chain"), undefined);
    assert.equal(readiness.getReadiness().subsystems.processing, "stopped");
});

test("pool shutdown retains registry entries until socket finalization and close chains settle", async () => {
    const previousToken = process.env.SQUEEZARR_RUNNER_TOKEN;
    process.env.SQUEEZARR_RUNNER_TOKEN = "pool-shutdown-token";
    const server = http.createServer((_req, res) => res.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    attach(server);

    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/runner`, {
        headers: { Authorization: "Bearer pool-shutdown-token" },
    });
    client.on("error", () => {});
    await once(client, "open");
    client.send(JSON.stringify({ type: "register", runnerId: "shutdown-runner", host: "test" }));
    while (!registry.get("shutdown-runner")) {
        await new Promise((resolve) => setImmediate(resolve));
    }

    let releaseFinalization;
    const finalization = new Promise((resolve) => {
        releaseFinalization = resolve;
    });
    const socket = registry.get("shutdown-runner").ws;
    serializeSocketEvent(socket, () => finalization);
    const draining = shutdownPool();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(registry.get("shutdown-runner"), "registry is retained while finalization is active");

    releaseFinalization();
    await draining;
    assert.equal(registry.get("shutdown-runner"), undefined);
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.SQUEEZARR_RUNNER_TOKEN;
    else process.env.SQUEEZARR_RUNNER_TOKEN = previousToken;
});

test("heartbeat watchdog terminates stale sockets once and retains timely runners", () => {
    const stale = registerBusy({ runnerId: "stale" });
    const timely = registerBusy({ runnerId: "timely", jobId: "job-2", assignmentId: "lease-2" });
    const now = 1_000_000;
    stale.runner.lastHeartbeatAt = now - RUNNER_HEARTBEAT_TIMEOUT_MS - 1;
    timely.runner.lastHeartbeatAt = now - RUNNER_HEARTBEAT_TIMEOUT_MS;

    assert.equal(evictStaleRunners(now), 1);
    assert.equal(stale.ws.terminated, 1);
    assert.equal(timely.ws.terminated, 0);
    timely.runner.lastHeartbeatAt = now + 1;
    assert.equal(evictStaleRunners(now + 1), 0);
    assert.equal(stale.ws.terminated, 1);
});
