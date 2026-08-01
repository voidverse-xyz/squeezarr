// Barrel for the Mongoose schemas — the single source of truth for the shape, defaults, and
// indexes of every document the app stores. Each schema module exports plain functions
// (getSchema/getName); database.js maps the `COLLECTION` names to these modules and compiles
// the models via getModel(). Named exports only, namespaced per module so `export * as`
// barrels work uniformly.
export * as fileSchema from "./file.js";
export * as jobSchema from "./job.js";
export * as settingsSchema from "./settings.js";
