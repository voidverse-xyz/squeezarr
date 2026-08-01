import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter } from "./routes/index.js";
import { shutdownService } from "./services/index.js";

const FRONTEND_DIR = process.env.FRONTEND_DIR || fileURLToPath(new URL("../frontend/out", import.meta.url));

// Construct HTTP middleware without starting the monitor or runner. Startup and API tests share
// this wiring; the monitor supplies the same request tracker to its shutdown coordinator.
export function createApp({
    requestTracker = shutdownService.createRequestTracker(),
    frontendDir = FRONTEND_DIR,
} = {}) {
    const app = express();
    const api = apiRouter();

    // Track before JSON parsing and routing so shutdown can reject new traffic immediately and
    // drain admitted handlers even after their clients disconnect.
    app.use(requestTracker.middleware);
    app.use(express.json());
    app.use("/api", api);

    app.use(express.static(frontendDir, { extensions: ["html"] }));
    app.use((req, res, next) => {
        if (req.method !== "GET" || req.path.startsWith("/api/")) {
            return next();
        }
        res.sendFile(path.join(frontendDir, "index.html"));
    });

    return app;
}
