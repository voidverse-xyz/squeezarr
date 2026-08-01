import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../database/index.js";
import * as jobService from "../services/job.js";
import { COLLECTION, FILE_STATUS, JOB_STATUS, JOB_TYPE, SETTINGS_DOC_ID } from "shared/domain.js";

// Schemas are the single source of truth for document shape + defaults. db.getModel()
// compiles a model from a schema's getSchema(); Mongoose applies defaults and casting at
// construction time, so these run with no database connection — keeping `npm test`
// database-free (mirrors the rest of the suite).
const File = db.getModel(COLLECTION.files);
const Job = db.getModel(COLLECTION.jobs);
const Settings = db.getModel(COLLECTION.settings);

test("a new File document gets its lifecycle defaults from the schema", () => {
    const file = new File({ fileId: "abc123", path: "/data/movie.mkv" });

    assert.equal(file.fileId, "abc123");
    assert.equal(file.path, "/data/movie.mkv");
    assert.equal(file.size, 0);
    assert.equal(file.status, FILE_STATUS.pending);
    assert.equal(typeof file.addedAt, "number");
    assert.deepEqual(file.transcodeResults.toObject(), []);
    assert.equal(file.replaced, false);
    assert.equal(file.cancelled, false);
    assert.equal(file.activeJobId, null);
    assert.equal(file.activeSettingId, null);
    assert.equal(file.activeProbeJobId, null);
    assert.equal(file.activePhase, null);
    assert.equal(file.failureMessage, null);
    assert.equal(file.currentOutputPath, null);
    assert.equal(file.reservedOutputPath, null);
    assert.equal(file.overwriteJournal, null);
    assert.equal(file.adjacentJournal, null);
    assert.deepEqual(file.retiredOutputPaths.toObject(), []);
});

test("a new Job document defaults to pending with a creation timestamp", () => {
    const job = new Job({ jobId: "job-1", type: "SCAN_DIRECTORY" });

    assert.equal(job.jobId, "job-1");
    assert.equal(job.type, "SCAN_DIRECTORY");
    assert.equal(job.status, JOB_STATUS.pending);
    assert.equal(typeof job.createdAt, "number");
    assert.equal(job.startedAt, null);
    assert.equal(job.finishedAt, null);
    assert.equal(job.preparedOutputPath, null);
    assert.equal(job.finalOutputPath, null);
    assert.equal(job.taskGenerationId, null);
    assert.equal(job.outputMode, null);
    assert.equal(job.lifecyclePhase, null);
    assert.deepEqual(job.payload, {});
});

test("a new Settings document has the general defaults and no stored presets", () => {
    const settings = new Settings();

    assert.equal(settings.settingsId, SETTINGS_DOC_ID);
    assert.equal(settings.autoScanIntervalMinutes, 60);
    assert.equal(settings.processingPaused, false);
    // dataDir / ffmpegPath / ffprobePath are server config (env), no longer on the settings doc.
    assert.equal(settings.dataDir, undefined);

    // Built-in presets are code-sourced and merged in by settingsService at read time, never stored,
    // so the schema's transcodeSettings default is empty.
    assert.deepEqual(settings.transcodeSettings.toObject(), []);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function installJobModelStore(t, initial = []) {
    const documents = new Map(initial.map((document) => [document.jobId, structuredClone(document)]));
    const originals = new Map();
    for (const method of ["findOne", "replaceOne", "deleteOne"]) {
        originals.set(method, {
            own: Object.hasOwn(Job, method),
            value: Job[method],
        });
    }

    Job.findOne = ({ jobId }) => ({
        lean: async () => (documents.has(jobId) ? structuredClone(documents.get(jobId)) : null),
    });
    Job.replaceOne = async ({ jobId }, document) => {
        documents.set(jobId, structuredClone(document));
        return { acknowledged: true };
    };
    Job.deleteOne = async ({ jobId }) => ({ deletedCount: documents.delete(jobId) ? 1 : 0 });

    t.after(() => {
        for (const [method, original] of originals) {
            if (original.own) {
                Job[method] = original.value;
            } else {
                delete Job[method];
            }
        }
    });
    return documents;
}

const runningJob = (jobId) => ({
    jobId,
    type: JOB_TYPE.TRANSCODE_FILE,
    status: JOB_STATUS.running,
    payload: { fileId: `file-${jobId}` },
});

const pendingJob = (jobId) => ({ ...runningJob(jobId), status: JOB_STATUS.pending });

async function nextTurn() {
    await new Promise((resolve) => setImmediate(resolve));
}

test("same-ID updates serialize the complete read, callback, and replacement sequence", async (t) => {
    const documents = installJobModelStore(t, [pendingJob("same")]);
    const firstRead = deferred();
    const releaseFirst = deferred();
    let secondRead = false;

    const first = db.update(COLLECTION.jobs, "same", async (job) => {
        firstRead.resolve();
        await releaseFirst.promise;
        return { ...job, progress: 10 };
    });
    await firstRead.promise;
    const second = db.update(COLLECTION.jobs, "same", (job) => {
        secondRead = true;
        assert.equal(job.progress, "10", "the successor reads only after the first replacement");
        return { ...job, progress: 20 };
    });

    await nextTurn();
    assert.equal(secondRead, false);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.equal(documents.get("same").progress, "20");
});

test("same-ID add waits for an earlier update replacement", async (t) => {
    const documents = installJobModelStore(t, [pendingJob("add")]);
    const updateRead = deferred();
    const releaseUpdate = deferred();
    const update = db.update(COLLECTION.jobs, "add", async (job) => {
        updateRead.resolve();
        await releaseUpdate.promise;
        return { ...job, progress: 1 };
    });
    await updateRead.promise;
    const add = db.add(COLLECTION.jobs, "add", {
        type: JOB_TYPE.SCAN_DIRECTORY,
        payload: { generation: "replacement" },
    });

    await nextTurn();
    assert.equal(documents.get("add").type, JOB_TYPE.TRANSCODE_FILE);
    releaseUpdate.resolve();
    await Promise.all([update, add]);
    assert.equal(documents.get("add").type, JOB_TYPE.SCAN_DIRECTORY);
    assert.deepEqual(documents.get("add").payload, { generation: "replacement" });
});

test("different document IDs mutate concurrently", async (t) => {
    const documents = installJobModelStore(t, [pendingJob("blocked"), pendingJob("free")]);
    const blockedRead = deferred();
    const releaseBlocked = deferred();
    let freeRead = false;

    const blocked = db.update(COLLECTION.jobs, "blocked", async (job) => {
        blockedRead.resolve();
        await releaseBlocked.promise;
        return { ...job, progress: 1 };
    });
    await blockedRead.promise;
    const free = db.update(COLLECTION.jobs, "free", (job) => {
        freeRead = true;
        return { ...job, progress: 2 };
    });

    await free;
    assert.equal(freeRead, true);
    assert.equal(documents.get("free").progress, "2");
    releaseBlocked.resolve();
    await blocked;
});

test("a rejected callback releases its same-ID successor", async (t) => {
    const documents = installJobModelStore(t, [pendingJob("release-callback")]);
    const rejected = db.update(COLLECTION.jobs, "release-callback", () => {
        throw new Error("callback failed");
    });
    const successor = db.update(COLLECTION.jobs, "release-callback", (job) => ({ ...job, progress: 42 }));

    await assert.rejects(rejected, /callback failed/);
    await successor;
    assert.equal(documents.get("release-callback").progress, "42");
});

test("a rejected database replacement releases its same-ID successor", async (t) => {
    const documents = installJobModelStore(t, [pendingJob("release-database")]);
    const replaceOne = Job.replaceOne;
    let rejectNext = true;
    Job.replaceOne = (...args) => {
        if (rejectNext) {
            rejectNext = false;
            throw new Error("replacement failed");
        }
        return replaceOne(...args);
    };

    const rejected = db.update(COLLECTION.jobs, "release-database", (job) => ({ ...job, progress: 1 }));
    const successor = db.update(COLLECTION.jobs, "release-database", (job) => ({ ...job, progress: 2 }));

    await assert.rejects(rejected, /replacement failed/);
    await successor;
    assert.equal(documents.get("release-database").progress, "2");
});

test("job lifecycle races resolve from FIFO state without stale replacement", async (t) => {
    const documents = installJobModelStore(t, [
        pendingJob("claim-fail"),
        runningJob("complete-fail"),
        runningJob("fail-complete"),
        runningJob("progress-complete"),
        runningJob("reset-complete"),
        runningJob("complete-reset"),
    ]);

    await Promise.all([jobService.claim("claim-fail"), jobService.failIfActive("claim-fail", "failed after claim")]);
    assert.equal(documents.get("claim-fail").status, JOB_STATUS.failed);

    await Promise.all([
        jobService.completeIfRunning("complete-fail"),
        jobService.failIfActive("complete-fail", "late"),
    ]);
    assert.equal(documents.get("complete-fail").status, JOB_STATUS.done);

    await Promise.all([
        jobService.failIfActive("fail-complete", "first"),
        jobService.completeIfRunning("fail-complete"),
    ]);
    assert.equal(documents.get("fail-complete").status, JOB_STATUS.failed);

    await Promise.all([
        jobService.updateProgress("progress-complete", 75),
        jobService.completeIfRunning("progress-complete"),
    ]);
    assert.equal(documents.get("progress-complete").status, JOB_STATUS.done);
    assert.equal(documents.get("progress-complete").progress, "75");

    const reset = (jobId) =>
        db.update(COLLECTION.jobs, jobId, (job) =>
            job?.status === JOB_STATUS.running ? { ...job, status: JOB_STATUS.pending } : job,
        );
    await Promise.all([reset("reset-complete"), jobService.completeIfRunning("reset-complete")]);
    assert.equal(documents.get("reset-complete").status, JOB_STATUS.pending, "the earlier reset wins the transition");
    await Promise.all([jobService.completeIfRunning("complete-reset"), reset("complete-reset")]);
    assert.equal(documents.get("complete-reset").status, JOB_STATUS.done, "a terminal completion cannot be reset");
});

test("update and remove are ordered for the same document", async (t) => {
    const documents = installJobModelStore(t, [runningJob("remove")]);
    const updateRead = deferred();
    const releaseUpdate = deferred();
    const update = db.update(COLLECTION.jobs, "remove", async (job) => {
        updateRead.resolve();
        await releaseUpdate.promise;
        return { ...job, progress: 99 };
    });
    await updateRead.promise;
    const remove = db.remove(COLLECTION.jobs, "remove");
    await nextTurn();
    assert.equal(documents.has("remove"), true, "remove waits for the preceding replacement");
    releaseUpdate.resolve();
    await Promise.all([update, remove]);
    assert.equal(documents.has("remove"), false);
});
