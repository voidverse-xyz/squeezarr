// Barrel for the controllers — the business-logic layer between the thin route handlers and
// the services/database. Route handlers import this barrel under a namespaced
// `<x>Controller` alias. Named exports only, so `export * as` barrels work uniformly. These
// are single-resource controllers (no role split): the app has one type of caller.
export * as filesController from "./files/index.js";
export * as jobsController from "./jobs.js";
export * as settingsController from "./settings.js";
export * as statsController from "./stats.js";
export * as actionsController from "./actions.js";
export * as runnersController from "./runners.js";
export * as authController from "./auth.js";
