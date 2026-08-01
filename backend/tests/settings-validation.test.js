import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSettings } from "../services/settings-validation.js";
import { OUTPUT_MODE, FILTER_ID } from "shared/domain.js";

// validateSettings is the security-critical boundary for the settings PUT: it decides which ffmpeg
// flags reach a spawn() and which output-path parts are safe. It returns { error: "invalid_<field>" }
// (handed straight back through the getResult envelope) or { value } (the cleaned payload). These run
// with no database — pure input validation.

// A fully-valid transcode setting; tests clone and mutate the one field under test.
function validSetting(overrides = {}) {
    return {
        id: "user-1",
        name: "My preset",
        enabled: true,
        priority: 10,
        fileExtensions: ["mkv"],
        matchPattern: "\\.mkv$",
        flags: "-map 0 -c:v libx265 -crf 26 -preset slow -c:a aac",
        outputMode: OUTPUT_MODE.adjacent,
        prefix: "",
        suffix: ".hevc",
        outputExtension: "mkv",
        filters: [FILTER_ID.acceptMinimalSize],
        deleteOnReject: false,
        createdAt: 0,
        ...overrides,
    };
}

function validSettings(transcodeSettings = [validSetting()]) {
    return {
        videoExtensions: ["mkv", "mp4"],
        autoScanIntervalMinutes: 60,
        transcodeSettings,
        revision: "revision-1",
    };
}

test("accepts a well-formed payload and returns the cleaned value", () => {
    const { error, value } = validateSettings(validSettings());
    assert.equal(error, undefined);
    assert.equal(value.transcodeSettings.length, 1);
    assert.equal(value.transcodeSettings[0].flags, "-map 0 -c:v libx265 -crf 26 -preset slow -c:a aac");
    assert.deepEqual(value.videoExtensions, ["mkv", "mp4"]);
});

test("rejects arrays and incomplete replacement payloads", () => {
    assert.equal(validateSettings(null).error, "invalid_settings");
    assert.equal(validateSettings("nope").error, "invalid_settings");
    assert.equal(validateSettings([]).error, "invalid_settings");
    assert.equal(validateSettings({}).error, "invalid_videoExtensions");
    assert.equal(validateSettings({ ...validSettings(), videoExtensions: undefined }).error, "invalid_videoExtensions");
    assert.equal(
        validateSettings({ ...validSettings(), transcodeSettings: undefined }).error,
        "invalid_transcodeSettings",
    );
    assert.equal(validateSettings({ ...validSettings(), revision: undefined }).error, "invalid_revision");
});

test("rejects malformed nested list containers", () => {
    assert.equal(
        validateSettings(validSettings([validSetting({ fileExtensions: "mkv" })])).error,
        "invalid_fileExtensions",
    );
    assert.equal(validateSettings(validSettings([validSetting({ filters: {} })])).error, "invalid_filters");
});

test("a missing name or id rejects the setting", () => {
    assert.equal(validateSettings(validSettings([validSetting({ name: "" })])).error, "invalid_name");
    assert.equal(validateSettings(validSettings([validSetting({ id: "" })])).error, "invalid_settingId");
});

test("a flag not on the allowlist is rejected", () => {
    // -f (format/protocol) and -i (extra input) are deliberately absent from the allowlist.
    assert.equal(validateSettings(validSettings([validSetting({ flags: "-f mp4" })])).error, "invalid_flags");
    assert.equal(validateSettings(validSettings([validSetting({ flags: "-i /etc/passwd" })])).error, "invalid_flags");
});

test("a stream-specifier flag matches on its base option (-c:v -> -c)", () => {
    const { error } = validateSettings(validSettings([validSetting({ flags: "-c:v libx265 -c:a:0 aac" })]));
    assert.equal(error, undefined);
});

test("a token containing a slash (path or protocol) is rejected", () => {
    assert.equal(validateSettings(validSettings([validSetting({ flags: "-map /data/x" })])).error, "invalid_flags");
    assert.equal(
        validateSettings(validSettings([validSetting({ flags: "-c:v http://evil/x" })])).error,
        "invalid_flags",
    );
});

test("a token containing a NUL byte is rejected", () => {
    assert.equal(
        validateSettings(validSettings([validSetting({ flags: "-c:v libx265\0evil" })])).error,
        "invalid_flags",
    );
});

test("empty flags are allowed (server still builds a valid ffmpeg command)", () => {
    const { error, value } = validateSettings(validSettings([validSetting({ flags: "" })]));
    assert.equal(error, undefined);
    assert.equal(value.transcodeSettings[0].flags, "");
});

test("over-long or too-many-token flags are rejected", () => {
    assert.equal(validateSettings(validSettings([validSetting({ flags: "x".repeat(1001) })])).error, "invalid_flags");
    const manyTokens = Array.from({ length: 61 }, () => "x").join(" ");
    assert.equal(validateSettings(validSettings([validSetting({ flags: manyTokens })])).error, "invalid_flags");
});

test("output-path parts can't escape the output directory", () => {
    assert.equal(validateSettings(validSettings([validSetting({ prefix: "../x" })])).error, "invalid_prefix");
    assert.equal(validateSettings(validSettings([validSetting({ suffix: "a/b" })])).error, "invalid_suffix");
    assert.equal(
        validateSettings(validSettings([validSetting({ outputExtension: "mk/v" })])).error,
        "invalid_outputExtension",
    );
});

test("an uncompilable or over-long match pattern is rejected", () => {
    assert.equal(validateSettings(validSettings([validSetting({ matchPattern: "(" })])).error, "invalid_matchPattern");
    assert.equal(
        validateSettings(validSettings([validSetting({ matchPattern: "a".repeat(501) })])).error,
        "invalid_matchPattern",
    );
});

test("an empty match pattern is allowed (matches everything)", () => {
    const { error } = validateSettings(validSettings([validSetting({ matchPattern: "" })]));
    assert.equal(error, undefined);
});

test("coerces scalar fields and drops unknown filters", () => {
    const { value } = validateSettings(
        validSettings([
            validSetting({
                enabled: "true",
                priority: "999999",
                deleteOnReject: 1,
                filters: [FILTER_ID.sameFile, "not-a-real-filter"],
            }),
        ]),
    );
    const s = value.transcodeSettings[0];
    assert.equal(s.enabled, true);
    assert.equal(s.priority, 999); // clamped to max
    assert.equal(s.deleteOnReject, false); // only true/"true" coerce to true
    assert.deepEqual(s.filters, [FILTER_ID.sameFile]);
});

test("an unknown output mode falls back to adjacent", () => {
    const { value } = validateSettings(validSettings([validSetting({ outputMode: "wormhole" })]));
    assert.equal(value.transcodeSettings[0].outputMode, OUTPUT_MODE.adjacent);
});
