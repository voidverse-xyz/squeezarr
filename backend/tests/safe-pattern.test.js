import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createPatternMatcher, matchesPattern, WORKER_STARTUP_TIMEOUT_MS } from "../services/safe-pattern.js";
import { getMatchingSettings, probeMedia, FFPROBE_TIMEOUT_DIAGNOSTIC } from "../services/probe.js";

class FakeClock {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.timers = new Map();
    }

    setTimeout(callback, delay) {
        const id = this.nextId++;
        this.timers.set(id, { callback, dueAt: this.now + delay });
        return id;
    }

    clearTimeout(id) {
        this.timers.delete(id);
    }

    tick(milliseconds) {
        this.now += milliseconds;
        while (true) {
            const next = [...this.timers.entries()]
                .filter(([, timer]) => timer.dueAt <= this.now)
                .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
            if (!next) return;
            const [id, timer] = next;
            this.timers.delete(id);
            timer.callback();
        }
    }
}

class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
        this.terminationCount = 0;
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminationCount += 1;
        return Promise.resolve();
    }

    becomeReady() {
        this.emit("online");
        this.emit("message", { type: "ready" });
    }

    respond(matched) {
        this.emit("message", { type: "result", matched });
    }
}

function createMatcherHarness(workers, startupTimeoutMs = 100) {
    const clock = new FakeClock();
    const matcher = createPatternMatcher({
        workerFactory: () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        },
        startupTimeoutMs,
        setTimeoutImpl: clock.setTimeout.bind(clock),
        clearTimeoutImpl: clock.clearTimeout.bind(clock),
    });
    return { clock, matcher };
}

test("safe pattern matching preserves ordinary JavaScript regular expressions", async () => {
    assert.equal(await matchesPattern("/movies/example.mkv", "\\.mkv$", 1_000), true);
    assert.equal(await matchesPattern("/movies/example.mp4", "\\.mkv$", 1_000), false);
});

test("delayed worker startup does not consume the regex execution budget", async () => {
    const workers = [];
    const { clock, matcher } = createMatcherHarness(workers);
    const result = matcher("/movies/example.mkv", "\\.mkv$", 25);

    clock.tick(75);
    assert.deepEqual(workers[0].messages, []);
    workers[0].emit("online");
    assert.deepEqual(workers[0].messages, []);
    workers[0].emit("message", { type: "ready" });
    assert.equal(workers[0].messages.length, 1);

    clock.tick(24);
    workers[0].respond(true);
    assert.equal(await result, true);
    assert.equal(workers[0].terminationCount, 1);
});

test("worker startup failure and deadline fail closed", async () => {
    const failedMatcher = createPatternMatcher({
        workerFactory: () => {
            throw new Error("startup failed");
        },
    });
    assert.equal(await failedMatcher("value", "value"), false);

    const failedWorkers = [];
    const { matcher: initializationFailureMatcher } = createMatcherHarness(failedWorkers);
    const initializationFailure = initializationFailureMatcher("value", "value");
    failedWorkers[0].emit("error", new Error("initialization failed"));
    assert.equal(await initializationFailure, false);
    assert.equal(failedWorkers[0].terminationCount, 1);

    const workers = [];
    const { clock, matcher } = createMatcherHarness(workers, 50);
    const result = matcher("value", "value");
    let settled = false;
    result.then(() => {
        settled = true;
    });

    clock.tick(49);
    await Promise.resolve();
    assert.equal(settled, false);
    clock.tick(1);
    assert.equal(await result, false);
    assert.equal(workers[0].terminationCount, 1);
});

test("the execution deadline terminates a ready worker and later patterns still run", async () => {
    const workers = [];
    const { clock, matcher } = createMatcherHarness(workers);
    const timedOut = matcher("hostile input", "^(a+)+$", 25);
    workers[0].becomeReady();
    clock.tick(25);
    assert.equal(await timedOut, false);
    assert.equal(workers[0].terminationCount, 1);

    const later = matcher("/movies/example.mkv", "\\.mkv$", 25);
    workers[1].becomeReady();
    workers[1].respond(true);
    assert.equal(await later, true);
    assert.equal(workers[1].terminationCount, 1);
});

test("catastrophic backtracking is terminated within a bounded time", async () => {
    const started = Date.now();
    const matched = await matchesPattern(`${"a".repeat(20_000)}!`, "^(a+)+$", 25);
    assert.equal(matched, false);
    assert.ok(Date.now() - started < WORKER_STARTUP_TIMEOUT_MS + 500);
});

test("a timed-out pattern does not prevent a later pattern from matching", async () => {
    const filePath = `/data/${"a".repeat(10_000)}!.mkv`;
    assert.equal(await matchesPattern(filePath, "^/data/(a+)+$", 25), false);
    assert.equal(await matchesPattern(filePath, "\\.mkv$", 1_000), true);
});

test("matching settings await safe regexes while preserving filtering and profile order", async () => {
    const filePath = `/data/${"a".repeat(10_000)}!.mkv`;
    const profiles = [
        { id: "timed-out", priority: 1, createdAt: 0, fileExtensions: ["mkv"], matchPattern: "^/data/(a+)+$" },
        { id: "later", priority: 5, createdAt: 20, fileExtensions: ["mkv"], matchPattern: "\\.mkv$" },
        { id: "earlier", priority: 5, createdAt: 10, fileExtensions: [], matchPattern: "\\.mkv$" },
        { id: "wrong-extension", priority: 0, fileExtensions: ["mp4"], matchPattern: "" },
        { id: "disabled", enabled: false, priority: 0, fileExtensions: ["mkv"], matchPattern: "" },
    ];

    const matching = await getMatchingSettings(profiles, filePath);
    assert.deepEqual(
        matching.map((profile) => profile.id),
        ["earlier", "later"],
    );
});

test("probeMedia force-kills a real process at its wall-clock deadline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "squeezarr-probe-timeout-"));
    const executable = path.join(directory, "hanging-probe");
    const pidPath = path.join(directory, "pid");
    await writeFile(
        executable,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    await chmod(executable, 0o700);

    try {
        await assert.rejects(probeMedia("/unused", { executable, timeoutMs: 1_000 }), (error) => {
            assert.equal(error.code, "FFPROBE_TIMEOUT");
            assert.equal(error.message, FFPROBE_TIMEOUT_DIAGNOSTIC);
            return true;
        });
        const pid = Number(await readFile(pidPath, "utf8"));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("probeMedia preserves ordinary spawn and output errors", async () => {
    const spawnError = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    await assert.rejects(
        probeMedia("/unused", {
            execFileImpl: (_executable, _args, _options, callback) => callback(spawnError),
        }),
        (error) => error === spawnError,
    );
});
