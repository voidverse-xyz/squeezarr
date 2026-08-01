import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatestRequest } from "../src/lib/latest-request.js";

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

for (const completionOrder of ["first-then-second", "second-then-first"]) {
    test(`latest request wins when responses complete ${completionOrder}`, async () => {
        const latest = createLatestRequest();
        const slow = deferred();
        const fast = deferred();
        const published = [];

        const first = latest.start();
        const firstResult = slow.promise.then((value) => {
            if (first.isLatest()) published.push(value);
        });
        const second = latest.start();
        const secondResult = fast.promise.then((value) => {
            if (second.isLatest()) published.push(value);
        });
        assert.equal(first.signal.aborted, true);

        if (completionOrder === "first-then-second") {
            slow.resolve("obsolete");
            await firstResult;
            fast.resolve("current");
        } else {
            fast.resolve("current");
            await secondResult;
            slow.resolve("obsolete");
        }
        await Promise.all([firstResult, secondResult]);
        assert.deepEqual(published, ["current"]);
    });
}

test("cancel aborts the active generation and prevents publication", () => {
    const latest = createLatestRequest();
    const request = latest.start();
    latest.cancel();
    assert.equal(request.signal.aborted, true);
    assert.equal(request.isLatest(), false);
});
