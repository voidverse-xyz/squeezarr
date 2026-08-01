import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as client from "../src/api/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    client.setAuthToken("");
    client.setUnauthorizedHandler(null);
});

function abortableHang() {
    return (_url, { signal }) =>
        new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
}

test("client distinguishes timeout from caller cancellation", async () => {
    globalThis.fetch = abortableHang();
    const timedOut = await client.get("slow", { timeoutMs: 20 });
    assert.equal(timedOut.error.kind, client.API_ERROR_KIND.timeout);
    assert.equal(timedOut.output, "request_timeout");

    const controller = new AbortController();
    const pending = client.get("cancelled", { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.error.kind, client.API_ERROR_KIND.cancelled);
    assert.equal(cancelled.output, "request_cancelled");
});

test("deadline remains active through response parsing and listeners are cleaned up", async () => {
    let requestSignal;
    globalThis.fetch = async (_url, options) => {
        requestSignal = options.signal;
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: () =>
                new Promise((_resolve, reject) => {
                    requestSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                        once: true,
                    });
                }),
        };
    };
    const result = await client.get("slow-json", { timeoutMs: 20 });
    assert.equal(result.error.kind, client.API_ERROR_KIND.timeout);

    let adds = 0;
    let removes = 0;
    const signal = {
        aborted: false,
        addEventListener() {
            adds += 1;
        },
        removeEventListener() {
            removes += 1;
        },
    };
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, output: "ok" }));
    assert.equal((await client.get("ok", { signal, timeoutMs: 1000 })).success, true);
    assert.equal(adds, 1);
    assert.equal(removes, 1);
});

test("cancelling response parsing preserves the HTTP status and cannot invalidate the session", async () => {
    let unauthorized = 0;
    client.setAuthToken("current-token");
    client.setUnauthorizedHandler(() => {
        unauthorized += 1;
    });

    for (const rejectParsing of [true, false]) {
        const controller = new AbortController();
        globalThis.fetch = async () => ({
            ok: false,
            status: 401,
            json: async () => {
                controller.abort();
                if (rejectParsing) throw new DOMException("aborted", "AbortError");
                return { success: false, output: "unauthorized" };
            },
        });

        const result = await client.get("settings", { signal: controller.signal });
        assert.equal(result.success, false);
        assert.equal(result.output, "request_cancelled");
        assert.deepEqual(result.error, { kind: client.API_ERROR_KIND.cancelled, status: 401 });
        assert.equal(result.status, 401);
        assert.equal(unauthorized, 0);
    }
});

test("an obsolete 401 cannot clear a newer bearer", async () => {
    let resolveFirst;
    globalThis.fetch = () =>
        new Promise((resolve) => {
            resolveFirst = resolve;
        });
    let unauthorized = 0;
    client.setUnauthorizedHandler(() => {
        unauthorized += 1;
    });
    client.setAuthToken("old-token");
    const oldRequest = client.get("settings");
    client.setAuthToken("new-token");
    resolveFirst(new Response(JSON.stringify({ success: false, output: "unauthorized" }), { status: 401 }));
    assert.equal((await oldRequest).status, 401);
    assert.equal(unauthorized, 0);

    globalThis.fetch = async () =>
        new Response(JSON.stringify({ success: false, output: "unauthorized" }), { status: 401 });
    await client.get("settings");
    assert.equal(unauthorized, 1);
});

test("a timed-out mutation is sent once and is never automatically replayed", async () => {
    let calls = 0;
    globalThis.fetch = (...args) => {
        calls += 1;
        return abortableHang()(...args);
    };
    const result = await client.post("actions/scan", undefined, { timeoutMs: 20 });
    assert.equal(result.error.kind, client.API_ERROR_KIND.timeout);
    assert.equal(calls, 1);
});
