import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mongo from "../services/mongo.js";

function fakeProcess() {
    const proc = new EventEmitter();
    proc.exitCode = null;
    proc.kill = (signal) => {
        proc.exitCode = signal === "SIGKILL" ? 137 : 0;
        queueMicrotask(() => proc.emit("exit", proc.exitCode, signal));
    };
    return proc;
}

const startOptions = (proc, onFatal) => ({
    spawnProcess: () => proc,
    waitUntilReady: async () => {},
    ensureDataDir: async () => {},
    onFatal,
});

test("unexpected mongod exit clears readiness and invokes the fatal supervisor", async (t) => {
    t.mock.method(console, "error", () => {});
    const proc = fakeProcess();
    let fatalError = null;
    await mongo.start(
        startOptions(proc, (error) => {
            fatalError = error;
        }),
    );
    assert.equal(mongo.getState().ready, true);

    proc.exitCode = 12;
    proc.emit("exit", 12, null);

    assert.equal(mongo.getState().ready, false);
    assert.equal(mongo.getState().status, "failed");
    assert.match(fatalError.message, /code 12/);
});

test("intentional mongod shutdown does not invoke the fatal supervisor", async () => {
    const proc = fakeProcess();
    let fatalCalls = 0;
    await mongo.start(
        startOptions(proc, () => {
            fatalCalls++;
        }),
    );

    await mongo.stop();

    assert.equal(fatalCalls, 0);
    assert.equal(mongo.getState().ready, false);
});
