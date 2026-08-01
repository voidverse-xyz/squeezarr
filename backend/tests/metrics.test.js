import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCpuPercent } from "../services/runner.js";

// computeCpuPercent is the pure half of the runner's CPU metric: utilization % between two
// aggregate cpuSample() readings ({ idle, total } tick counts). No clock/IO, so it's testable.

test("computeCpuPercent returns null on the first sample (no prior)", () => {
    assert.equal(computeCpuPercent(null, { idle: 100, total: 400 }), null);
});

test("computeCpuPercent returns null when no ticks elapsed between samples", () => {
    const s = { idle: 100, total: 400 };
    assert.equal(computeCpuPercent(s, s), null);
});

test("computeCpuPercent computes utilization from idle/total deltas", () => {
    // 100 total ticks elapsed, 25 of them idle → 75% busy.
    const prev = { idle: 100, total: 400 };
    const cur = { idle: 125, total: 500 };
    assert.equal(computeCpuPercent(prev, cur), 75);
});

test("computeCpuPercent reports 0 when the whole delta was idle", () => {
    const prev = { idle: 100, total: 400 };
    const cur = { idle: 200, total: 500 };
    assert.equal(computeCpuPercent(prev, cur), 0);
});

test("computeCpuPercent reports 100 when no idle ticks elapsed", () => {
    const prev = { idle: 100, total: 400 };
    const cur = { idle: 100, total: 500 };
    assert.equal(computeCpuPercent(prev, cur), 100);
});
