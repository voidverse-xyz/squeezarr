// Public entry for the data layer — callers do `import * as db from "../database/index.js"`.
// Split by single responsibility: connection lifecycle (connection.js), Mongoose model/schema
// plumbing (models.js), and the collection-keyed CRUD facade (facade.js). Document shape,
// defaults, and indexes live in the schemas under ./schemas (the single source of truth).
export { connect, close } from "./connection.js";
export { getModel, defaults } from "./models.js";
export { add, get, update, patch, exists, remove, getAll, find } from "./facade.js";
