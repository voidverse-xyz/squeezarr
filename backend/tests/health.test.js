import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { apiRouter } from "../routes/index.js";
import * as readiness from "../services/readiness.js";
import { trackConnectionReadiness } from "../database/connection.js";

async function withApi(state, fn) {
    const app = express();
    app.use("/api", apiRouter({ readiness: () => state }));
    const server = app.listen(0);
    try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("readiness requires every monitor subsystem", () => {
    readiness.reset();
    for (const subsystem of ["mongod", "database", "queue", "processing"]) {
        readiness.setSubsystem(subsystem, true);
    }
    let state = readiness.getReadiness();
    assert.equal(state.ready, false);
    assert.equal(state.subsystems.http, "stopped");

    readiness.setSubsystem("http", true);
    state = readiness.getReadiness();
    assert.equal(state.ready, true);
    assert.equal(state.status, "ready");
    readiness.reset();
});

test("processing readiness reports capacity without flapping for busy or paused runners", () => {
    readiness.reset();
    readiness.setProcessingCapacity({ connected: 1, idle: 1, busy: 0, paused: 0, accepting: 1 });
    let state = readiness.getReadiness();
    assert.equal(state.subsystems.processing, "ready");
    assert.equal(state.capacity.processing.accepting, 1);

    readiness.setProcessingCapacity({ connected: 2, idle: 0, busy: 1, paused: 1, accepting: 0 });
    state = readiness.getReadiness();
    assert.equal(state.subsystems.processing, "ready");
    assert.deepEqual(state.capacity.processing, { connected: 2, idle: 0, busy: 1, paused: 1, accepting: 0 });

    readiness.setProcessingCapacity({ connected: 0, idle: 0, busy: 0, paused: 0, accepting: 0 });
    assert.equal(readiness.getReadiness().subsystems.processing, "no_runners");
    readiness.stopProcessing();
    assert.equal(readiness.getReadiness().subsystems.processing, "stopped");
    readiness.reset();
});

test("database connection lifecycle updates readiness and recovers after reconnect", () => {
    readiness.reset();
    const connection = new EventEmitter();
    connection.readyState = 0;
    trackConnectionReadiness(connection);
    assert.equal(readiness.getReadiness().subsystems.database, "disconnected");

    connection.readyState = 1;
    connection.emit("connected");
    assert.equal(readiness.getReadiness().subsystems.database, "ready");

    // A driver error can be informational while Mongoose still considers the connection open.
    connection.emit("error", new Error("transient"));
    assert.equal(readiness.getReadiness().subsystems.database, "ready");

    connection.readyState = 0;
    connection.emit("disconnected");
    assert.equal(readiness.getReadiness().subsystems.database, "disconnected");
    connection.emit("error", new Error("unavailable"));
    assert.equal(readiness.getReadiness().subsystems.database, "failed");

    connection.readyState = 1;
    connection.emit("reconnected");
    assert.equal(readiness.getReadiness().subsystems.database, "ready");

    connection.readyState = 0;
    connection.emit("close");
    assert.equal(readiness.getReadiness().subsystems.database, "closed");
    readiness.reset();
});

test("health returns 503 with subsystem state when the monitor is not ready", () =>
    withApi(
        {
            ready: false,
            status: "not_ready",
            subsystems: {
                mongod: "ready",
                database: "ready",
                queue: "crashed",
                http: "ready",
                processing: "ready",
            },
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/health`);
            assert.equal(response.status, 503);
            const body = await response.json();
            assert.equal(body.success, false);
            assert.equal(body.output, "not_ready");
            assert.equal(body.data.subsystems.queue, "crashed");
        },
    ));

test("health returns 200 only for a ready monitor", () =>
    withApi(
        {
            ready: true,
            status: "ready",
            subsystems: {
                mongod: "ready",
                database: "ready",
                queue: "ready",
                http: "ready",
                processing: "ready",
            },
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/health`);
            assert.equal(response.status, 200);
            assert.equal((await response.json()).success, true);
        },
    ));
