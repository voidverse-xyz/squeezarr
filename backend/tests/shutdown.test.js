import { once } from "node:events";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { JOB_TYPE } from "shared/domain.js";
import { dispatchTranscodes } from "../services/event/dispatch.js";
import { createRequestTracker, createShutdownCoordinator, trackRequestHandler } from "../services/shutdown.js";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function coordinatorHarness({ started = new Set(["http", "database", "mongod"]), deadlineMs = 1000 } = {}) {
    const order = [];
    const exits = [];
    const httpDrain = deferred();
    const autoscanDrain = deferred();
    const queueDrain = deferred();
    const runnerDrain = deferred();
    const poolDrain = deferred();
    const requestDrain = deferred();
    const httpServer = {
        close(callback) {
            order.push("http-close");
            httpDrain.promise.then(() => callback());
        },
        closeAllConnections() {
            order.push("http-force");
        },
    };
    const coordinator = createShutdownCoordinator({
        requestTracker: {
            stopAccepting: () => order.push("http-reject"),
            waitForIdle: () => requestDrain.promise,
            activeCount: () => 1,
        },
        getHttpServer: () => httpServer,
        getStartupPromise: () => Promise.resolve(order.push("startup-drained")),
        isStarted: (name) => started.has(name),
        readinessService: { setSubsystem: () => order.push("readiness-stopping") },
        autoscanService: {
            shutdown: () => {
                order.push("autoscan-stop");
                return autoscanDrain.promise;
            },
        },
        eventService: {
            shutdown: () => {
                order.push("queue-stop");
                return queueDrain.promise;
            },
            getState: () => ({ status: "draining" }),
        },
        runnerService: {
            shutdown: () => {
                order.push("runner-stop");
                return runnerDrain.promise;
            },
            forceShutdown: () => order.push("runner-force"),
        },
        runnerpoolService: {
            beginShutdown: () => order.push("pool-begin"),
            shutdown: () => {
                order.push("pool-drain");
                return poolDrain.promise;
            },
            forceShutdown: () => order.push("pool-force"),
            getShutdownState: () => ({ socketCount: 2 }),
        },
        database: {
            close: async () => order.push("db-close"),
        },
        mongoService: {
            stop: async () => order.push("mongod-stop"),
        },
        logger: { log: () => {}, error: () => {} },
        deadlineMs,
        exit: (code) => exits.push(code),
    });
    return {
        coordinator,
        order,
        exits,
        releaseDrains() {
            httpDrain.resolve();
            autoscanDrain.resolve();
            queueDrain.resolve();
            runnerDrain.resolve();
            poolDrain.resolve();
            requestDrain.resolve();
        },
    };
}

test("shutdown establishes one synchronous barrier and closes persistence after every drain", async () => {
    const harness = coordinatorHarness();
    const first = harness.coordinator.shutdown("SIGTERM");
    const second = harness.coordinator.shutdown("SIGINT");
    assert.equal(first, second, "repeated signals join the cached promise");
    assert.deepEqual(harness.order.slice(0, 8), [
        "readiness-stopping",
        "http-reject",
        "autoscan-stop",
        "pool-begin",
        "queue-stop",
        "runner-stop",
        "pool-drain",
        "http-close",
    ]);
    assert.equal(harness.order.includes("db-close"), false);

    harness.releaseDrains();
    const result = await first;
    assert.equal(result.exitCode, 0);
    assert.ok(harness.order.indexOf("db-close") > harness.order.indexOf("pool-drain"));
    assert.ok(harness.order.indexOf("mongod-stop") > harness.order.indexOf("db-close"));
    assert.deepEqual(harness.exits, [0]);
    assert.equal(harness.order.filter((item) => item === "queue-stop").length, 1);
});

test("a later fatal callback promotes a signal-started cached shutdown to nonzero", async () => {
    const harness = coordinatorHarness();
    const signal = harness.coordinator.shutdown("SIGTERM");
    const fatal = harness.coordinator.shutdown("queue failure", { failed: true });
    assert.equal(signal, fatal);
    harness.releaseDrains();

    assert.equal((await signal).exitCode, 1);
    assert.deepEqual(harness.exits, [1]);
    assert.equal(harness.order.filter((item) => item === "queue-stop").length, 1);
});

test("partial startup skips unopened persistence while still stopping in-memory acceptance", async () => {
    const harness = coordinatorHarness({ started: new Set() });
    const shutdown = harness.coordinator.shutdown("startup failure", { failed: true });
    harness.releaseDrains();
    const result = await shutdown;
    assert.equal(result.exitCode, 1);
    assert.equal(harness.order.includes("http-close"), false);
    assert.equal(harness.order.includes("db-close"), false);
    assert.equal(harness.order.includes("mongod-stop"), false);
    assert.equal(harness.order.filter((item) => item === "pool-begin").length, 1);
});

test("teardown errors are aggregated, later cleanup continues, and exit is nonzero", async () => {
    const order = [];
    const exits = [];
    const coordinator = createShutdownCoordinator({
        isStarted: () => true,
        eventService: { shutdown: async () => Promise.reject(new Error("queue rollback failed")) },
        runnerpoolService: {
            beginShutdown() {},
            shutdown: async () => Promise.reject(new Error("socket finalization failed")),
        },
        database: {
            close: async () => {
                order.push("db-close");
                throw new Error("driver failure");
            },
        },
        mongoService: { stop: async () => order.push("mongod-stop") },
        logger: { log: () => {}, error: () => {} },
        exit: (code) => exits.push(code),
    });
    const result = await coordinator.shutdown("SIGTERM");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(order, ["db-close", "mongod-stop"]);
    assert.deepEqual(exits, [1]);
    assert.deepEqual(result.errors.map(({ label }) => label).sort(), [
        "database close",
        "queue drain",
        "runner pool drain",
    ]);
});

test("SIGTERM during transcode reset/failure persistence exits nonzero after later teardown", async (t) => {
    t.mock.method(console, "error", () => {});
    const resetEntered = deferred();
    const resetPersistence = deferred();
    const failureEntered = deferred();
    const failurePersistence = deferred();
    let running = true;
    const dispatch = dispatchTranscodes([{ jobId: "transcode-cleanup" }], {
        idleRunnerCount: () => 1,
        isPaused: async () => false,
        isRunning: () => running,
        job: {
            claim: async (jobId) => ({ jobId, type: JOB_TYPE.TRANSCODE_FILE, payload: { fileId: "cleanup-file" } }),
            fail: async () => {
                failureEntered.resolve();
                await failurePersistence.promise;
            },
        },
        prepare: async () => {
            throw new Error("prepare failed");
        },
        assign: async () => assert.fail("must not assign"),
        reset: async () => {
            resetEntered.resolve();
            await resetPersistence.promise;
        },
    });
    await resetEntered.promise;

    const order = [];
    const exits = [];
    const coordinator = createShutdownCoordinator({
        isStarted: (name) => ["database", "mongod"].includes(name),
        eventService: {
            shutdown() {
                running = false;
                return dispatch;
            },
        },
        database: { close: async () => order.push("db-close") },
        mongoService: { stop: async () => order.push("mongod-stop") },
        logger: { log() {}, error() {} },
        exit: (code) => exits.push(code),
    });
    const shutdown = coordinator.shutdown("SIGTERM");
    assert.deepEqual(order, [], "persistence remains open while queue cleanup is pending");

    resetPersistence.resolve();
    await failureEntered.promise;
    assert.deepEqual(order, [], "persistence remains open while terminal failure is pending");
    failurePersistence.reject(new Error("failure persistence rejected"));

    const result = await shutdown;
    assert.equal(result.exitCode, 1);
    assert.deepEqual(order, ["db-close", "mongod-stop"]);
    assert.deepEqual(exits, [1]);
    assert.deepEqual(
        result.errors.map(({ label }) => label),
        ["queue drain"],
    );
    const [queueError] = result.errors;
    assert.ok(queueError.error instanceof AggregateError);
    assert.deepEqual(
        queueError.error.errors.map(({ message }) => message),
        ["prepare failed", "failure persistence rejected"],
    );
});

test("deadline force-closes transports once and never closes persistence under an active drain", async () => {
    let fireDeadline;
    const order = [];
    const exits = [];
    const never = new Promise(() => {});
    const coordinator = createShutdownCoordinator({
        requestTracker: { stopAccepting() {}, waitForIdle: () => never, activeCount: () => 3 },
        getHttpServer: () => ({
            close() {},
            closeAllConnections: () => order.push("http-force"),
        }),
        isStarted: () => true,
        eventService: { shutdown: () => never, getState: () => ({ status: "draining" }) },
        runnerpoolService: {
            beginShutdown() {},
            shutdown: () => never,
            forceShutdown: () => order.push("pool-force"),
            getShutdownState: () => ({ socketCount: 2 }),
        },
        runnerService: { shutdown: () => never, forceShutdown: () => order.push("runner-force") },
        database: { close: async () => order.push("db-close") },
        mongoService: { stop: async () => order.push("mongod-stop") },
        logger: { log: () => {}, error: () => order.push("deadline-log") },
        setTimer: (callback) => {
            fireDeadline = callback;
            return { unref() {} };
        },
        clearTimer() {},
        exit: (code) => exits.push(code),
    });
    const shutdown = coordinator.shutdown("SIGTERM");
    fireDeadline();
    const result = await shutdown;
    assert.equal(result.deadlineExpired, true);
    assert.deepEqual(exits, [1]);
    assert.deepEqual(order, ["deadline-log", "http-force", "pool-force", "runner-force"]);
    assert.equal(order.includes("db-close"), false);
});

test("an admitted HTTP request drains while a keep-alive race is rejected with 503", async () => {
    const tracker = createRequestTracker();
    const entered = deferred();
    const release = deferred();
    const app = express();
    app.use(tracker.middleware);
    app.get(
        "/defer",
        trackRequestHandler(async (_req, res) => {
            entered.resolve();
            await release.promise;
            res.send("done");
        }),
    );
    app.get("/race", (_req, res) => res.send("must not run"));
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const socket = net.connect(server.address().port, "127.0.0.1");
    const socketClosed = once(socket, "close");
    await once(socket, "connect");
    let response = "";
    socket.on("data", (chunk) => {
        response += chunk.toString();
    });
    socket.write("GET /defer HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
    await entered.promise;
    tracker.stopAccepting();
    let serverClosed = false;
    const closed = new Promise((resolve) =>
        server.close(() => {
            serverClosed = true;
            resolve();
        }),
    );
    socket.write("GET /race HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(serverClosed, false);
    assert.equal(tracker.activeCount(), 1);

    release.resolve();
    await tracker.waitForIdle();
    await closed;
    await socketClosed;
    assert.match(response, /HTTP\/1\.1 200 OK/);
    assert.match(response, /HTTP\/1\.1 503 Service Unavailable/);
    assert.match(response, /Connection: close/i);
});

test("a client disconnect cannot let DB close before its admitted async handler settles", async () => {
    const tracker = createRequestTracker();
    const entered = deferred();
    const release = deferred();
    const app = express();
    app.use(tracker.middleware);
    app.get(
        "/mutation",
        trackRequestHandler(async (_req, res) => {
            entered.resolve();
            await release.promise;
            if (!res.destroyed) res.send("done");
        }),
    );
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const socket = net.connect(server.address().port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("GET /mutation HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await entered.promise;
    const disconnected = once(socket, "close");
    socket.destroy();
    await disconnected;

    let databaseClosed = false;
    const exits = [];
    const coordinator = createShutdownCoordinator({
        requestTracker: tracker,
        getHttpServer: () => server,
        isStarted: (name) => ["http", "database"].includes(name),
        database: { close: async () => (databaseClosed = true) },
        logger: { log() {}, error() {} },
        exit: (code) => exits.push(code),
    });
    const shutdown = coordinator.shutdown("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tracker.activeCount(), 1);
    assert.equal(databaseClosed, false);

    release.resolve();
    assert.equal((await shutdown).exitCode, 0);
    assert.equal(databaseClosed, true);
    assert.deepEqual(exits, [0]);
});

test("runner-only SIGTERM awaits its shutdown promise and exits zero", { timeout: 5000 }, async () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const backendDir = path.join(testDir, "..");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: backendDir,
        env: {
            ...process.env,
            HOST_IP: "127.0.0.1",
            MONITOR_PORT: "9",
            SQUEEZARR_RUNNER_TOKEN: "shutdown-test-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk.toString();
    });
    while (!output.includes("starting runner")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null);
    assert.equal(code, 0);
});

test(
    "runner-only authentication failure drains through the coordinator and exits nonzero",
    { timeout: 5000 },
    async () => {
        const monitor = http.createServer();
        monitor.on("upgrade", (_req, socket) => {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
        });
        monitor.listen(0, "127.0.0.1");
        await once(monitor, "listening");

        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const child = spawn(process.execPath, ["server.js"], {
            cwd: path.join(testDir, ".."),
            env: {
                ...process.env,
                HOST_IP: "127.0.0.1",
                MONITOR_PORT: String(monitor.address().port),
                SQUEEZARR_RUNNER_TOKEN: "rejected-runner-token",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const [code, signal] = await once(child, "exit");
        await new Promise((resolve) => monitor.close(resolve));
        assert.equal(signal, null);
        assert.equal(code, 1);
    },
);
