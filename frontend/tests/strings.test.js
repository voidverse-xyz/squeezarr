import { test } from "node:test";
import assert from "node:assert/strict";
import { locales } from "../src/lib/strings.js";

test("operational retry states are localized in English and Spanish", () => {
    for (const language of ["en", "es"]) {
        const strings = locales[language];
        for (const key of [
            "loadError",
            "staleWarning",
            "ambiguousAction",
            "ambiguousActionRefreshFailed",
            "ambiguousScanBlocked",
            "pauseReconciliationRequired",
        ]) {
            assert.ok(strings.dashboard[key]);
        }
        for (const action of [
            "scan",
            "processing",
            "workerPause",
            "delete",
            "deleteOutput",
            "replace",
            "stop",
            "requeue",
            "default",
        ]) {
            assert.ok(strings.dashboard.actionErrors[action]);
        }
        for (const key of [
            "loadError",
            "pauseError",
            "scanError",
            "ambiguousScan",
            "ambiguousMutation",
            "ambiguousMutationRefreshFailed",
            "pauseReconciliationRequired",
        ]) {
            assert.ok(strings.settings[key]);
        }
        assert.ok(strings.auth.unavailable);
        assert.ok(strings.actions.retry);
        assert.ok(strings.actions.refresh);
    }
});
