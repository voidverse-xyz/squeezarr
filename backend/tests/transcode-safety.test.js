import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, copyFile, rm, stat, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as db from "../database/index.js";
import * as settings from "../services/settings.js";
import { validateSettings } from "../services/settings/validation.js";
import { getMatchingSettings, probeMedia } from "../services/probe.js";
import { prepareTranscode, finalizeTranscode, validateOutput } from "../services/ffmpeg.js";
import { replace } from "../controllers/files/mutations.js";
import {
    COLLECTION,
    SETTINGS_DOC_ID,
    FILE_STATUS,
    JOB_STATUS,
    JOB_TYPE,
    OUTPUT_MODE,
    RESULT_STATUS,
} from "shared/domain.js";

const run = promisify(execFile);

// Exercise the real facade and schema casting without connecting to a database.
function memoryDatabase(t) {
    for (const collection of [COLLECTION.files, COLLECTION.jobs, COLLECTION.settings]) {
        const Model = db.getModel(collection);
        const documents = new Map();
        const idField =
            collection === COLLECTION.files ? "fileId" : collection === COLLECTION.jobs ? "jobId" : "settingsId";
        t.mock.method(Model, "findOne", (filter) => ({
            lean: async () => structuredClone(documents.get(filter[idField]) ?? null),
        }));
        t.mock.method(Model, "replaceOne", async (filter, document) => {
            documents.set(filter[idField], structuredClone(document));
        });
        t.mock.method(Model, "find", (filter) => ({
            lean: async () =>
                structuredClone(
                    [...documents.values()].filter((document) =>
                        Object.entries(filter).every(([key, expected]) => {
                            const value = key.split(".").reduce((object, part) => object?.[part], document);
                            return expected?.$in ? expected.$in.includes(value) : value === expected;
                        }),
                    ),
                ),
        }));
    }
}

test("built-in enabled overrides survive schema persistence, pause changes and revision checks", async (t) => {
    memoryDatabase(t);
    const original = await settings.get();
    const custom = { ...original.transcodeSettings[0], id: "custom", isDefault: false };
    const edited = {
        ...original,
        transcodeSettings: [
            ...original.transcodeSettings.map((s) => ({ ...s, enabled: false, name: "tampered" })),
            custom,
        ],
    };
    const validated = validateSettings(edited);
    assert.equal(validated.error, undefined);
    const saved = await settings.save(validated.value);
    assert.equal(saved.error, undefined);
    assert.equal(saved.value.transcodeSettings[0].enabled, false);
    assert.equal(saved.value.transcodeSettings[0].name, original.transcodeSettings[0].name);
    assert.notEqual(saved.value.revision, original.revision);
    const stored = await db.get(COLLECTION.settings, SETTINGS_DOC_ID);
    assert.deepEqual(
        stored.transcodeSettings.map((s) => s.id),
        ["custom"],
    );
    assert.equal(stored.builtinOverrides.find((s) => s.id === "default-hevc").enabled, false);
    assert.equal((await settings.save(original)).error, "settings_conflict");

    await settings.setProcessing(true);
    await settings.setProcessing(false);
    const reloaded = await settings.get();
    assert.equal(reloaded.processingPaused, false);
    const matches = await getMatchingSettings(reloaded.transcodeSettings, "/data/movie.mp4");
    assert.deepEqual(
        matches.map((s) => s.id),
        ["custom"],
    );

    reloaded.transcodeSettings.find((s) => s.id === "default-av1").enabled = true;
    const enabled = await settings.save(validateSettings(reloaded).value);
    assert.equal(enabled.value.transcodeSettings.find((s) => s.id === "default-av1").enabled, true);
    assert.equal(enabled.value.transcodeSettings.find((s) => s.id === "default-hevc").enabled, false);
});

test("transcode output validation and replacement preserve originals on invalid output", async (t) => {
    memoryDatabase(t);
    t.mock.method(console, "error", () => {});
    const dir = await mkdtemp(path.join(os.tmpdir(), "squeezarr-safety-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, "fixture.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=32x32:d=0.2", "-c:v", "mpeg4", source]);
    const originalBytes = await readFile(source);
    const audio = path.join(dir, "audio.wav");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.2", audio]);
    await assert.rejects(validateOutput(audio), /no valid video stream/);
    assert.equal((await validateOutput(source)).size, originalBytes.length);

    const profile = {
        id: "overwrite",
        name: "Overwrite",
        enabled: true,
        flags: "-c:v mpeg4 -an",
        outputMode: OUTPUT_MODE.overwrite,
        outputExtension: "mkv",
        filters: [],
    };
    await db.add(COLLECTION.settings, SETTINGS_DOC_ID, { transcodeSettings: [profile] });

    for (const [name, bytes] of [
        ["empty", Buffer.alloc(0)],
        ["invalid", Buffer.from("not media")],
        ["audio", await readFile(audio)],
    ]) {
        await t.test(`${name} output cannot replace an original despite a successful worker report`, async () => {
            const fileId = name;
            const inputPath = path.join(dir, `${name}.mp4`);
            await copyFile(source, inputPath);
            await db.add(COLLECTION.files, fileId, {
                path: inputPath,
                size: originalBytes.length,
                status: FILE_STATUS.queued,
            });
            await db.add(COLLECTION.jobs, name, {
                type: JOB_TYPE.TRANSCODE_FILE,
                status: JOB_STATUS.running,
                payload: { fileId, settingId: profile.id },
            });
            const task = await prepareTranscode(await db.get(COLLECTION.jobs, name));
            assert.equal(path.extname(task.outputPath), ".mp4");
            assert.equal(task.finalOutputPath, inputPath);
            await writeFile(task.outputPath, bytes);
            const outcome = await finalizeTranscode(await db.get(COLLECTION.jobs, name), {
                exitCode: 0,
                cancelled: false,
            });
            assert.equal(outcome.failed, true);
            assert.deepEqual(await readFile(inputPath), originalBytes);
            const failed = await db.get(COLLECTION.files, fileId);
            assert.equal(failed.status, FILE_STATUS.failed);
            assert.equal(failed.activeJobId, null);
            assert.equal(failed.transcodeResults[0].status, RESULT_STATUS.failed);
            assert.equal((await db.get(COLLECTION.jobs, name)).status, JOB_STATUS.failed);
            await assert.rejects(access(task.outputPath), { code: "ENOENT" });
        });
    }

    await t.test("a real encode preserves the overwrite container and completes", async () => {
        const inputPath = path.join(dir, "valid.mp4");
        await copyFile(source, inputPath);
        await db.add(COLLECTION.files, "valid", {
            path: inputPath,
            size: originalBytes.length,
            status: FILE_STATUS.queued,
        });
        await db.add(COLLECTION.jobs, "valid", {
            type: JOB_TYPE.TRANSCODE_FILE,
            status: JOB_STATUS.running,
            payload: { fileId: "valid", settingId: profile.id },
        });
        const task = await prepareTranscode(await db.get(COLLECTION.jobs, "valid"));
        await run(task.executable, task.args);
        const outcome = await finalizeTranscode(await db.get(COLLECTION.jobs, "valid"), {
            exitCode: 0,
            cancelled: false,
        });
        assert.equal(outcome.completed, true);
        const media = JSON.parse((await probeMedia(inputPath)).stdout);
        assert.ok(media.format.format_name.split(",").includes("mp4"));
        const file = await db.get(COLLECTION.files, "valid");
        assert.equal(file.status, FILE_STATUS.replaced);
        assert.equal(file.path, inputPath);
        assert.equal(file.size, (await stat(inputPath)).size);
        assert.equal(file.activeJobId, null);
    });

    await t.test("adjacent encoding still supports a different output container", async () => {
        const adjacentProfile = { ...profile, outputMode: OUTPUT_MODE.adjacent };
        await db.add(COLLECTION.settings, SETTINGS_DOC_ID, { transcodeSettings: [adjacentProfile] });
        const inputPath = path.join(dir, "adjacent.mp4");
        await copyFile(source, inputPath);
        await db.add(COLLECTION.files, "adjacent", {
            path: inputPath,
            size: originalBytes.length,
            status: FILE_STATUS.queued,
        });
        await db.add(COLLECTION.jobs, "adjacent", {
            type: JOB_TYPE.TRANSCODE_FILE,
            status: JOB_STATUS.running,
            payload: { fileId: "adjacent", settingId: profile.id },
        });
        const job = await db.get(COLLECTION.jobs, "adjacent");
        const task = await prepareTranscode(job);
        assert.equal(path.extname(task.outputPath), ".mkv");
        assert.equal(task.finalOutputPath, path.join(dir, "adjacent.mkv"));
        await run(task.executable, task.args);
        const preparedJob = await db.get(COLLECTION.jobs, "adjacent");
        assert.equal((await finalizeTranscode(preparedJob, { exitCode: 0 })).completed, true);
        assert.deepEqual(await readFile(inputPath), originalBytes);
        await validateOutput(task.finalOutputPath);
        assert.equal((await db.get(COLLECTION.files, "adjacent")).status, FILE_STATUS.transcoded);
    });

    await t.test("an older prepared overwrite with a mismatched extension fails safely", async () => {
        await db.add(COLLECTION.settings, SETTINGS_DOC_ID, { transcodeSettings: [profile] });
        const inputPath = path.join(dir, "legacy.mp4");
        await copyFile(source, inputPath);
        await db.add(COLLECTION.files, "legacy", {
            path: inputPath,
            size: originalBytes.length,
            status: FILE_STATUS.queued,
        });
        await db.add(COLLECTION.jobs, "legacy", {
            type: JOB_TYPE.TRANSCODE_FILE,
            status: JOB_STATUS.running,
            payload: { fileId: "legacy", settingId: profile.id },
        });
        const job = await db.get(COLLECTION.jobs, "legacy");
        const task = await prepareTranscode(job);
        const legacyOutput = `${task.outputPath}.mkv`;
        await copyFile(source, legacyOutput);
        await db.patch(COLLECTION.jobs, "legacy", { preparedOutputPath: legacyOutput });
        await db.update(COLLECTION.files, "legacy", (file) => ({
            ...file,
            currentOutputPath: legacyOutput,
            overwriteJournal: { ...file.overwriteJournal, tempPath: legacyOutput },
        }));
        const preparedJob = await db.get(COLLECTION.jobs, "legacy");
        const outcome = await finalizeTranscode(preparedJob, { exitCode: 0 });
        assert.equal(outcome.failed, true);
        assert.match(outcome.error, /extension differs/);
        assert.deepEqual(await readFile(inputPath), originalBytes);
        assert.equal((await db.get(COLLECTION.files, "legacy")).status, FILE_STATUS.failed);
        await assert.rejects(access(legacyOutput), { code: "ENOENT" });
    });

    await t.test(
        "manual replacement rejects mismatched extensions and invalid media, then accepts valid video",
        async () => {
            const inputPath = path.join(dir, "manual.mp4");
            const outputPath = path.join(dir, "manual-output.mp4");
            await copyFile(source, inputPath);
            await writeFile(outputPath, "");
            await db.add(COLLECTION.files, "manual", {
                path: inputPath,
                status: FILE_STATUS.transcoded,
                transcodeResults: [{ settingId: "manual", status: RESULT_STATUS.done, outputPath, outputSize: 1 }],
            });
            assert.equal((await replace("manual", "manual")).output, "invalid_transcode_output");
            assert.deepEqual(await readFile(inputPath), originalBytes);
            await db.update(COLLECTION.files, "manual", (file) => ({
                ...file,
                transcodeResults: [{ ...file.transcodeResults[0], outputPath: audio }],
            }));
            assert.equal((await replace("manual", "manual")).output, "output_extension_mismatch");
            assert.deepEqual(await readFile(inputPath), originalBytes);
            await db.update(COLLECTION.files, "manual", (file) => ({
                ...file,
                transcodeResults: [{ ...file.transcodeResults[0], outputPath }],
            }));
            await copyFile(source, outputPath);
            assert.equal((await replace("manual", "manual")).success, true);
            assert.equal((await db.get(COLLECTION.files, "manual")).size, originalBytes.length);
            await assert.rejects(access(outputPath), { code: "ENOENT" });
        },
    );
});
