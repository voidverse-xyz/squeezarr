import { test } from "node:test";
import assert from "node:assert/strict";
import { runFilters } from "../services/filters.js";
import { FILTER_ID } from "shared/domain.js";

test("filter filesystem errors fail finalization instead of accepting the output", async () => {
    await assert.rejects(
        runFilters([FILTER_ID.acceptMinimalSize], "/missing/input.mkv", "/missing/output.mkv"),
        /Filter "accept-minimal-size" failed:/,
    );
});
