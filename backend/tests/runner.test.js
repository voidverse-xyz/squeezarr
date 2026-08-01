import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
    armConnectAttemptDeadline,
    backoffDelay,
    ffmpegErrorTail,
    reconnectDecision,
    start as startRunner,
    shutdown as shutdownRunner,
} from "../services/runner.js";
import { startTask, cancelTask, abortCurrent } from "../services/runner/task.js";
import {
    RUNNER_BACKOFF_BASE_MS,
    RUNNER_BACKOFF_MAX_MS,
    RUNNER_CONNECT_MAX_MS,
    RUNNER_CONNECT_ATTEMPT_TIMEOUT_MS,
} from "../utilities/constants.js";

// The runner reconnect backoff is pure (no clock/IO), so the schedule is unit-testable.
test("backoff grows exponentially from the base", () => {
    assert.equal(backoffDelay(0), RUNNER_BACKOFF_BASE_MS);
    assert.equal(backoffDelay(1), RUNNER_BACKOFF_BASE_MS * 2);
    assert.equal(backoffDelay(2), RUNNER_BACKOFF_BASE_MS * 4);
});

test("backoff is capped at the max", () => {
    assert.equal(backoffDelay(100), RUNNER_BACKOFF_MAX_MS);
    assert.ok(backoffDelay(5) <= RUNNER_BACKOFF_MAX_MS);
});

test("a blackholed WebSocket attempt is terminated at its own deadline", () => {
    let callback;
    let scheduledMs;
    let cleared = 0;
    let timedOut = 0;
    const socket = {
        terminated: 0,
        terminate() {
            this.terminated += 1;
        },
    };
    const release = armConnectAttemptDeadline(socket, {
        setTimer(fn, ms) {
            callback = fn;
            scheduledMs = ms;
            return { unref() {} };
        },
        clearTimer() {
            cleared += 1;
        },
        onTimeout() {
            timedOut += 1;
        },
    });

    assert.equal(scheduledMs, RUNNER_CONNECT_ATTEMPT_TIMEOUT_MS);
    callback();
    assert.equal(timedOut, 1);
    assert.equal(socket.terminated, 1);
    release();
    assert.equal(cleared, 0);
});

test("reconnect policy exits only remote runners at and after the give-up window", () => {
    assert.deepEqual(reconnectDecision(RUNNER_CONNECT_MAX_MS - 1, true), {
        retry: true,
        exit: false,
        extendedOutage: false,
    });
    assert.deepEqual(reconnectDecision(RUNNER_CONNECT_MAX_MS, true), {
        retry: false,
        exit: true,
        extendedOutage: true,
    });
    assert.deepEqual(reconnectDecision(RUNNER_CONNECT_MAX_MS + 1, false), {
        retry: true,
        exit: false,
        extendedOutage: true,
    });
});

// ffmpegErrorTail extracts the real error from progress-heavy stderr (also pure).
test("ffmpegErrorTail pulls the error line out of progress noise", () => {
    const stderr =
        "frame=  100 fps= 50 q=28.0 size=    256kB time=00:00:04.00 bitrate= 524.3kbits/s speed=2x\n" +
        "/data/movie.mkv: No such file or directory\n";
    assert.match(ffmpegErrorTail(stderr), /No such file or directory/);
});

test("ffmpegErrorTail handles an error after a carriage-return-rewritten progress line", () => {
    // ffmpeg rewrites progress in place with \r, so the error can share a chunk with `frame=…`.
    const stderr = "frame=1 time=00:00:01.00\rframe=2 time=00:00:02.00\rUnknown encoder 'libx265'\n";
    const tail = ffmpegErrorTail(stderr);
    assert.match(tail, /Unknown encoder 'libx265'/);
    assert.doesNotMatch(tail, /frame=/);
});

test("ffmpegErrorTail caps the length", () => {
    const stderr = "x".repeat(5000) + "\nfatal: boom\n";
    assert.ok(ffmpegErrorTail(stderr, 100).length <= 100);
});

test("ffmpegErrorTail returns empty for progress-only output", () => {
    const stderr = "frame=  10 fps=5 time=00:00:01.00 bitrate=1kbits/s\nframe=  20 fps=5 time=00:00:02.00\n";
    assert.equal(ffmpegErrorTail(stderr), "");
});

function runTask(message, action) {
    const messages = [];
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`task ${message.taskId} did not settle`)), 3000);
        const send = (sent) => {
            messages.push(sent);
            if (sent.type === "result") {
                // Spawn failures emit both error and close. Wait briefly after the first result so a
                // duplicate callback would be observable before resolving the assertion.
                setTimeout(() => {
                    clearTimeout(timer);
                    resolve(messages);
                }, 30);
            }
        };
        startTask(message, send);
        action?.();
    });
}

const assignment = (taskId, executable, args = []) => ({
    taskId,
    assignmentId: `lease-${taskId}`,
    executable,
    args,
});

for (const [name, executableFactory, expectedError] of [
    ["missing executable", () => path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`), /ENOENT/],
    [
        "non-executable file",
        async () => {
            const executable = path.join(os.tmpdir(), `squeezarr-noexec-${crypto.randomUUID()}`);
            await writeFile(executable, "#!/bin/sh\nexit 0\n");
            await chmod(executable, 0o600);
            return executable;
        },
        /EACCES/,
    ],
]) {
    test(`${name} emits exactly one spawn-error result`, async () => {
        const executable = await executableFactory();
        try {
            const messages = await runTask(assignment(name, executable));
            const results = messages.filter(({ type }) => type === "result");
            assert.equal(results.length, 1);
            assert.equal(results[0].assignmentId, `lease-${name}`);
            assert.equal(results[0].exitCode, -1);
            assert.match(results[0].error, expectedError);
        } finally {
            if (name === "non-executable file") {
                await rm(executable, { force: true });
            }
        }
    });
}

test("normal success and nonzero exit each emit one documented result", async () => {
    const success = await runTask(assignment("success", process.execPath, ["-e", "process.exit(0)"]));
    assert.deepEqual(
        success.filter(({ type }) => type === "result"),
        [
            {
                type: "result",
                taskId: "success",
                assignmentId: "lease-success",
                exitCode: 0,
                cancelled: false,
                error: undefined,
            },
        ],
    );

    const failure = await runTask(
        assignment("failure", process.execPath, ["-e", "console.error('encoder failed'); process.exit(7)"]),
    );
    const results = failure.filter(({ type }) => type === "result");
    assert.equal(results.length, 1);
    assert.equal(results[0].exitCode, 7);
    assert.match(results[0].error, /encoder failed/);
});

test("user cancellation emits one cancelled result", async () => {
    const messages = await runTask(assignment("cancel", process.execPath, ["-e", "setInterval(() => {}, 1000)"]), () =>
        cancelTask("cancel"),
    );
    const results = messages.filter(({ type }) => type === "result");
    assert.equal(results.length, 1);
    assert.equal(results[0].cancelled, true);
});

test("remote reconnect give-up reports through the injected fatal callback", { timeout: 3000 }, async () => {
    let fatalError;
    const fatal = new Promise((resolve) => {
        startRunner({
            host: "127.0.0.1",
            port: 9,
            exitOnGiveUp: true,
            maxConnectMs: 0,
            onFatal: (error) => {
                fatalError = error;
                resolve();
            },
        });
    });
    await fatal;
    await shutdownRunner();
    assert.match(fatalError.message, /could not reach monitor/);
});

test("socket-loss abort emits no result and late callbacks cannot clear the next task", async () => {
    const oldMessages = [];
    startTask(assignment("old", process.execPath, ["-e", "setInterval(() => {}, 1000)"]), (message) =>
        oldMessages.push(message),
    );
    assert.equal(abortCurrent(), true);

    const nextMessages = await runTask(assignment("next", process.execPath, ["-e", "process.exit(0)"]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(oldMessages.filter(({ type }) => type === "result").length, 0);
    assert.equal(nextMessages.filter(({ type }) => type === "result").length, 1);
});
