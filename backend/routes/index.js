import { Router } from "express";
import files from "./files.js";
import jobs from "./jobs.js";
import runners from "./runners.js";
import settings from "./settings.js";
import stats from "./stats.js";
import actions from "./actions.js";
import auth from "./auth.js";
import health from "./health.js";
import { requireAuth } from "./middleware/auth.js";
import { handleError } from "./middleware/error.js";

// The /api router — one sub-router per resource, mounted under the path the fetch client
// already uses (see frontend/src/api/*). Paths and methods are 1:1 with the old Next.js
// route handlers, so the frontend needs no URL changes.
//
// Expected errors (validation, "not found", …) come back from controllers in the getResult
// envelope. The final handler is only a safety net: an unexpected throw (a controller bug, a DB
// failure) is rendered as that same envelope with a 500 rather than Express's default HTML page.
export function apiRouter() {
    const router = Router();

    router.use("/health", health);
    router.use("/auth", auth);
    router.use(requireAuth);
    router.use("/files", files);
    router.use("/jobs", jobs);
    router.use("/runners", runners);
    router.use("/settings", settings);
    router.use("/stats", stats);
    router.use("/actions", actions);
    router.use(handleError);
    return router;
}
