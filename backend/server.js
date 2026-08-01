import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./database/index.js";
import { apiRouter } from "./routes/index.js";
import {
    mongoService,
    eventService,
    scannerService,
    probeService,
    settingsService,
    processingService,
    runnerpoolService,
    runnerService,
    autoscanService,
    loggingService,
    readinessService,
    authService,
    shutdownService,
} from "./services/index.js";
import { JOB_TYPE } from "shared/domain.js";

// HOST_IP selects runner-only mode. Without it this process owns HTTP, mongod, the database,
// queue, runner pool, and an in-process runner connecting over loopback.
const HOST_IP = process.env.HOST_IP;
const PORT = Number(process.env.PORT) || 3000;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(dirname, "..", "frontend", "out");

function failForMissingEnv(mode, missing) {
    if (missing.length === 0) {
        return false;
    }
    loggingService.error("startup", `${mode} missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
}

// Request tracking is deliberately the first middleware, before JSON parsing and every route.
// Requests admitted before shutdown remain counted through their wrapped API handler promise (even
// after client disconnect); later requests racing on keep-alive receive 503 + Connection: close.
export function createApp(requestTracker = shutdownService.createRequestTracker()) {
    const app = express();
    app.use(requestTracker.middleware);
    app.use(express.json());
    app.use("/api", apiRouter());

    app.use(express.static(FRONTEND_DIR, { extensions: ["html"] }));
    app.use((req, res, next) => {
        if (req.method !== "GET" || req.path.startsWith("/api/")) {
            return next();
        }
        res.sendFile(path.join(FRONTEND_DIR, "index.html"));
    });

    return app;
}

function installSignalHandlers(coordinator) {
    process.on("SIGTERM", () => coordinator.shutdown("SIGTERM received"));
    process.on("SIGINT", () => coordinator.shutdown("SIGINT received"));
}

// --- Runner-only process ---
function startRunnerOnly(host) {
    let runnerStarted = false;
    const coordinator = shutdownService.createShutdownCoordinator({
        isStarted: (name) => name === "runner" && runnerStarted,
        runnerService,
        readinessService: null,
        logger: loggingService,
    });
    installSignalHandlers(coordinator);

    loggingService.log("startup", `runner-only mode — connecting to monitor at ${host}`);
    runnerService.start({
        host,
        port: Number(process.env.MONITOR_PORT) || undefined,
        exitOnGiveUp: true,
        onFatal: (error) => {
            loggingService.error("startup", "runner failed", error);
            void coordinator.shutdown("runner failure", { failed: true });
        },
    });
    runnerStarted = true;
}

// --- Monitor process ---
function startMonitor() {
    readinessService.reset();
    const started = {
        mongod: false,
        database: false,
        queue: false,
        http: false,
        runnerpool: false,
        runner: false,
    };
    const requestTracker = shutdownService.createRequestTracker();
    let httpServer = null;
    let startupPromise = null;

    const coordinator = shutdownService.createShutdownCoordinator({
        requestTracker,
        getHttpServer: () => httpServer,
        getStartupPromise: () => startupPromise,
        isStarted: (name) => Boolean(started[name]),
        autoscanService,
        eventService,
        runnerpoolService,
        runnerService,
        database: db,
        mongoService,
        readinessService,
        logger: loggingService,
    });
    const fatal = (source) => (error) => {
        readinessService.setSubsystem("http", false, "failed");
        loggingService.error("startup", `${source} failed`, error);
        void coordinator.shutdown(`${source} failure`, { failed: true });
    };
    installSignalHandlers(coordinator);

    startupPromise = (async () => {
        await mongoService.start({ onFatal: fatal("mongod") });
        started.mongod = true;
        if (coordinator.isShuttingDown()) return;

        await db.connect();
        started.database = true;
        if (coordinator.isShuttingDown()) return;

        await processingService.initialize();
        if (coordinator.isShuttingDown()) return;
        await settingsService.initialize();
        if (coordinator.isShuttingDown()) return;

        eventService.registerHandler(JOB_TYPE.SCAN_DIRECTORY, scannerService.handleScanDirectory);
        eventService.registerHandler(JOB_TYPE.PROBE_FILE, probeService.handleProbeFile);
        await eventService.initialize({ onFatal: fatal("queue") });
        started.queue = true;
        if (coordinator.isShuttingDown()) return;

        await eventService.enqueue(JOB_TYPE.SCAN_DIRECTORY, {});
        if (coordinator.isShuttingDown()) return;

        const settings = await settingsService.get();
        if (coordinator.isShuttingDown()) return;
        autoscanService.apply(settings.autoScanIntervalMinutes);

        readinessService.setSubsystem("http", false, "starting");
        httpServer = createServer(createApp(requestTracker));
        httpServer.once("error", fatal("HTTP server"));
        if (coordinator.isShuttingDown()) return;

        runnerpoolService.attach(httpServer);
        started.runnerpool = true;
        if (coordinator.isShuttingDown()) return;

        httpServer.listen(PORT, () => {
            if (coordinator.isShuttingDown()) {
                return;
            }
            started.http = true;
            readinessService.setSubsystem("http", true);
            loggingService.log("startup", `server listening on port ${PORT}`);
            runnerService.start({
                host: "127.0.0.1",
                port: PORT,
                exitOnGiveUp: false,
                onFatal: fatal("local runner"),
            });
            started.runner = true;
        });
        // listen() establishes the acceptance point synchronously, before its callback.
        started.http = true;
    })().catch((error) => fatal("startup")(error));
}

if (HOST_IP) {
    if (!failForMissingEnv("runner-only mode", authService.validateRunnerEnv())) {
        startRunnerOnly(HOST_IP);
    }
} else if (!failForMissingEnv("monitor mode", authService.validateMonitorEnv())) {
    startMonitor();
}
