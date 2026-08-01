// Shared building blocks for the per-document schemas in this directory.
//
// Node-loaded service code, so domain.js is imported relatively (see AGENTS.md import notes).
import mongoose from "mongoose";

const Schema = mongoose.Schema;
export const Mixed = Schema.Types.Mixed;

// `_id` is left to Mongo (an auto-generated ObjectId, never written by the app). Each schema
// instead carries its own indexed application-id field (fileId / jobId / settingsId) declared
// via getIdField(); database.js keys every read/write off that field. `versionKey: false`
// drops `__v`; `minimize: false` keeps empty objects/arrays so a stored doc always carries
// its full shape.
export const baseOptions = { versionKey: false, minimize: false };
