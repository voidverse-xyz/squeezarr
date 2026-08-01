import { test } from "node:test";
import assert from "node:assert/strict";
import { getDiscoveredFileSize } from "../services/scanner.js";

test("a file that disappears before stat is skipped", async () => {
    const stat = async () => {
        const error = new Error("gone");
        error.code = "ENOENT";
        throw error;
    };

    assert.equal(await getDiscoveredFileSize("/data/gone.mkv", stat), null);
});

test("a later scan can stat a path that previously disappeared", async () => {
    let exists = false;
    const stat = async () => {
        if (!exists) {
            const error = new Error("gone");
            error.code = "ENOENT";
            throw error;
        }
        return { size: 1234 };
    };

    assert.equal(await getDiscoveredFileSize("/data/movie.mkv", stat), null);
    exists = true;
    assert.equal(await getDiscoveredFileSize("/data/movie.mkv", stat), 1234);
});

test("stat permission errors are logged and do not become size-zero files", async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args));
    const stat = async () => {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
    };

    assert.equal(await getDiscoveredFileSize("/data/private.mkv", stat), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /could not stat \/data\/private\.mkv/);
});
