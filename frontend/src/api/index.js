"use client";

// Barrel for the frontend API layer — mirrors the backend's resource structure. Components
// and hooks import this under a namespaced `<x>Api` alias; all calls funnel through client.js.
export * as filesApi from "./files.js";
export * as jobsApi from "./jobs.js";
export * as settingsApi from "./settings.js";
export * as statsApi from "./stats.js";
export * as actionsApi from "./actions.js";
export * as runnersApi from "./runners.js";
export * as authApi from "./auth.js";
