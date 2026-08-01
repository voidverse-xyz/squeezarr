import { test } from "node:test";
import assert from "node:assert/strict";
import { collectKnownOutputPaths, findStrayOutputDocs } from "../utilities/scanpath.js";

// --- collectKnownOutputPaths ---

test("collects finished-transcode output paths", () => {
    const files = [
        {
            path: "/data/a.mkv",
            transcodeResults: [{ outputPath: "/data/a.hevc.mkv" }],
            currentOutputPath: null,
        },
    ];
    const known = collectKnownOutputPaths(files);
    assert.ok(known.has("/data/a.hevc.mkv"));
    assert.equal(known.has("/data/a.mkv"), false);
});

test("includes in-flight currentOutputPath so a scan mid-transcode excludes the partial output", () => {
    const files = [{ path: "/data/b.mkv", transcodeResults: [], currentOutputPath: "/data/b.hevc.mkv" }];
    const known = collectKnownOutputPaths(files);
    assert.ok(known.has("/data/b.hevc.mkv"), "the partial output is treated as known");
});

test("drops falsy outputs (null currentOutputPath, null result outputPath)", () => {
    const files = [
        // overwrite-mode result records outputPath: null — must not poison the set
        { path: "/data/c.mkv", transcodeResults: [{ outputPath: null }], currentOutputPath: null },
    ];
    const known = collectKnownOutputPaths(files);
    assert.equal(known.size, 0, "null outputs are filtered out, never matching real paths");
});

test("tolerates docs missing transcodeResults entirely", () => {
    const files = [{ path: "/data/d.mkv", currentOutputPath: null }];
    assert.equal(collectKnownOutputPaths(files).size, 0);
});

test("includes adjacent reservations, journals, overwrite journals, and retired stale generations", () => {
    const files = [
        {
            reservedOutputPath: "/data/a.final.mkv",
            adjacentJournal: {
                scratchPath: "/data/.a.scratch.mkv",
                finalPath: "/data/a.final.mkv",
            },
            overwriteJournal: {
                tempPath: "/data/.b.temp.mkv",
                backupPath: "/data/.b.backup.mkv",
            },
            retiredOutputPaths: ["/data/.a.retired-1.mkv", "/data/.a.retired-2.mkv"],
        },
    ];
    assert.deepEqual([...collectKnownOutputPaths(files)].sort(), [
        "/data/.a.retired-1.mkv",
        "/data/.a.retired-2.mkv",
        "/data/.a.scratch.mkv",
        "/data/.b.backup.mkv",
        "/data/.b.temp.mkv",
        "/data/a.final.mkv",
    ]);
});

test("collects across multiple files and multiple results", () => {
    const files = [
        {
            path: "/data/e.mkv",
            transcodeResults: [{ outputPath: "/data/e.av1.mkv" }],
            currentOutputPath: null,
        },
        {
            path: "/data/f.mkv",
            transcodeResults: [{ outputPath: "/data/f.x265.mkv" }, { outputPath: "/data/f.av1.mkv" }],
            currentOutputPath: "/data/f.tmp.mkv",
        },
    ];
    const known = collectKnownOutputPaths(files);
    assert.deepEqual([...known].sort(), ["/data/e.av1.mkv", "/data/f.av1.mkv", "/data/f.tmp.mkv", "/data/f.x265.mkv"]);
});

// --- findStrayOutputDocs ---

test("flags a doc whose own path is a known output of another transcode", () => {
    // source "g.mkv" produced "g.hevc.mkv"; a stray doc also exists for that output
    const files = [
        { fileId: "src", path: "/data/g.mkv", transcodeResults: [{ outputPath: "/data/g.hevc.mkv" }] },
        { fileId: "stray", path: "/data/g.hevc.mkv", transcodeResults: [] },
    ];
    const known = collectKnownOutputPaths(files);
    const stray = findStrayOutputDocs(files, known);
    assert.deepEqual(
        stray.map((f) => f.fileId),
        ["stray"],
    );
});

test("never flags a legitimate source doc whose path is not an output", () => {
    const files = [{ fileId: "src", path: "/data/h.mkv", transcodeResults: [{ outputPath: "/data/h.hevc.mkv" }] }];
    const known = collectKnownOutputPaths(files);
    assert.deepEqual(findStrayOutputDocs(files, known), [], "the source itself is never stray");
});

test("never treats a doc as stray for its OWN in-flight currentOutputPath", () => {
    // Defensive: if a doc's path somehow equals its own currentOutputPath, it is a live
    // in-progress source, not a stray output — it must not be deleted out from under ffmpeg.
    const files = [{ fileId: "live", path: "/data/i.mkv", currentOutputPath: "/data/i.mkv" }];
    const known = collectKnownOutputPaths(files);
    assert.ok(known.has("/data/i.mkv"));
    assert.deepEqual(findStrayOutputDocs(files, known), [], "self is excluded from stray removal");
});

test("never treats a source as stray for its own reserved or journal-owned path", () => {
    const reserved = {
        fileId: "reserved",
        path: "/data/reserved.mkv",
        reservedOutputPath: "/data/reserved.mkv",
    };
    const journal = {
        fileId: "journal",
        path: "/data/journal.mkv",
        adjacentJournal: { finalPath: "/data/journal.mkv" },
    };
    const files = [reserved, journal];
    assert.deepEqual(findStrayOutputDocs(files, collectKnownOutputPaths(files)), []);
});

test("flags a stray output even while its own source is mid-transcode", () => {
    const files = [
        { fileId: "src", path: "/data/j.mkv", currentOutputPath: "/data/j.hevc.mkv", transcodeResults: [] },
        { fileId: "stray", path: "/data/j.hevc.mkv", currentOutputPath: null, transcodeResults: [] },
    ];
    const known = collectKnownOutputPaths(files);
    assert.deepEqual(
        findStrayOutputDocs(files, known).map((f) => f.fileId),
        ["stray"],
    );
});
