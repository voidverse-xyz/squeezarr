// The live registry of connected runners. Assignment identity is intentionally in-memory: jobs
// remain the durable lifecycle record, while a fresh assignmentId fences results from an older
// socket or a previous dispatch of the same job.
import { WebSocket } from "ws";
import * as readiness from "../readiness.js";
import { RUNNER_STATUS } from "shared/domain.js";

const runners = new Map();
let accepting = true;

export function startAccepting() {
    accepting = true;
    publishCapacity();
}

export function stopAccepting() {
    accepting = false;
    publishCapacity();
}

export function isAccepting() {
    return accepting;
}

export function get(runnerId) {
    return runners.get(runnerId);
}

export function all() {
    return [...runners.values()];
}

function isLive(runner) {
    return !runner.watchdogExpired && runner.ws.readyState === WebSocket.OPEN;
}

export function capacity() {
    const live = all().filter(isLive);
    return {
        connected: live.length,
        idle: live.filter((runner) => runner.status === RUNNER_STATUS.idle).length,
        busy: live.filter((runner) => runner.status === RUNNER_STATUS.busy).length,
        paused: live.filter((runner) => runner.paused).length,
        accepting: accepting ? live.filter(isAvailable).length : 0,
    };
}

export function publishCapacity() {
    const snapshot = capacity();
    readiness.setProcessingCapacity(snapshot);
    return snapshot;
}

// Snapshot of the connected runners for the read API, minus transport/internal settlement state.
export function list() {
    return all().map(({ ws, cancelSent, assignmentPhase, currentAssignmentId, watchdogExpired, ...runner }) => runner);
}

export function register(ws, { runnerId, host, info }) {
    if (!accepting) {
        return null;
    }
    ws.runnerId = runnerId;
    const now = Date.now();
    const runner = {
        ws,
        runnerId,
        host,
        status: RUNNER_STATUS.idle,
        paused: false,
        currentJobId: null,
        currentAssignmentId: null,
        currentFileId: null,
        currentFile: null,
        progress: null,
        cancelSent: false,
        assignmentPhase: null,
        connectedAt: now,
        lastHeartbeatAt: now,
        info: info ?? null,
        metrics: null,
    };
    runners.set(runnerId, runner);
    publishCapacity();
    return runner;
}

// Expected-socket removal prevents an old close/reconnect callback from deleting a newer record.
export function remove(runnerId, expectedWs) {
    const runner = runners.get(runnerId);
    if (!runner || (expectedWs && runner.ws !== expectedWs)) {
        return null;
    }
    runners.delete(runnerId);
    publishCapacity();
    return runner;
}

function isAvailable(runner) {
    return runner.status === RUNNER_STATUS.idle && !runner.paused && runner.ws.readyState === WebSocket.OPEN;
}

export function firstIdle() {
    if (!accepting) {
        return null;
    }
    for (const runner of runners.values()) {
        if (isAvailable(runner)) {
            return runner;
        }
    }
    return null;
}

export function idleCount() {
    if (!accepting) {
        return 0;
    }
    let count = 0;
    for (const runner of runners.values()) {
        if (isAvailable(runner)) {
            count += 1;
        }
    }
    return count;
}

export function forJob(jobId) {
    for (const runner of runners.values()) {
        if (runner.currentJobId === jobId) {
            return runner;
        }
    }
    return null;
}

export function setPaused(runnerId, paused) {
    const runner = runners.get(runnerId);
    if (!runner) {
        return null;
    }
    runner.paused = paused;
    publishCapacity();
    return runner;
}

export function markBusy(runner, { jobId, assignmentId, fileId, currentFile }) {
    runner.status = RUNNER_STATUS.busy;
    runner.currentJobId = jobId;
    runner.currentAssignmentId = assignmentId;
    runner.currentFileId = fileId;
    runner.currentFile = currentFile ?? null;
    runner.progress = null;
    runner.cancelSent = false;
    runner.assignmentPhase = "running";
    runner.lastHeartbeatAt = Date.now();
    publishCapacity();
}

function matches(runner, ws, taskId, assignmentId) {
    return Boolean(
        runner &&
        runner.ws === ws &&
        runner.status === RUNNER_STATUS.busy &&
        runner.currentJobId === taskId &&
        runner.currentAssignmentId === assignmentId,
    );
}

// Claim before the first await in result handling. Close/reconnect recovery can then see that this
// assignment is already settling and must not requeue it.
export function claimResult(ws, taskId, assignmentId) {
    const runner = get(ws.runnerId);
    if (!matches(runner, ws, taskId, assignmentId) || runner.assignmentPhase !== "running") {
        return null;
    }
    runner.assignmentPhase = "settling";
    return runner;
}

export function updateProgress(ws, taskId, assignmentId, time) {
    const runner = get(ws.runnerId);
    if (!matches(runner, ws, taskId, assignmentId) || runner.assignmentPhase !== "running") {
        return false;
    }
    runner.progress = time;
    return true;
}

// Exactly one close/reconnect path can claim recovery. A result that already claimed settlement
// wins; recovery then returns null and cannot patch terminal work back to pending.
export function claimRecovery(runner) {
    if (!runner?.currentJobId || runner.assignmentPhase !== "running") {
        return null;
    }
    runner.assignmentPhase = "recovering";
    return {
        jobId: runner.currentJobId,
        fileId: runner.currentFileId,
        assignmentId: runner.currentAssignmentId,
    };
}

export function markIdle(runner, assignmentId) {
    if (
        get(runner.runnerId) !== runner ||
        runner.currentAssignmentId !== assignmentId ||
        runner.assignmentPhase !== "settling"
    ) {
        return false;
    }
    runner.status = RUNNER_STATUS.idle;
    runner.currentJobId = null;
    runner.currentAssignmentId = null;
    runner.currentFileId = null;
    runner.currentFile = null;
    runner.progress = null;
    runner.cancelSent = false;
    runner.assignmentPhase = null;
    publishCapacity();
    return true;
}

export function clear() {
    runners.clear();
    publishCapacity();
}
