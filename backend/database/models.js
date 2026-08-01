import mongoose from "mongoose";
import { fileSchema, jobSchema, settingsSchema } from "./schemas/index.js";
import { COLLECTION } from "shared/domain.js";

// Schemas export plain functions (getSchema/getName/getIdField); the model is compiled here.
const SCHEMA_MODULES = {
    [COLLECTION.files]: fileSchema,
    [COLLECTION.jobs]: jobSchema,
    [COLLECTION.settings]: settingsSchema,
};

// Compile and return the Mongoose model for a collection (cached on `mongoose.models`). The
// collection name is passed explicitly as the third argument so the Mongo collection never
// depends on Mongoose pluralization.
export function getModel(collection) {
    const mod = SCHEMA_MODULES[collection];
    if (!mod) {
        throw new Error(`Unknown collection: ${collection}`);
    }
    const name = mod.getName();
    return mongoose.models[name] || mongoose.model(name, mod.getSchema(), name);
}

// The application-id field for a collection (fileId / jobId / settingsId / runnerId), declared
// by the schema. Every facade read/write keys off this field, not Mongo's `_id`.
export function idFieldFor(collection) {
    return SCHEMA_MODULES[collection].getIdField();
}

// A fully-defaulted document for a collection, sourced from the schema (the single source of
// truth). Constructing a model instance applies defaults without DB I/O — and stamps a fresh
// ObjectId, so drop the `_id` the same way the read path projects it away (see facade.js).
export function defaults(collection) {
    const { _id, ...rest } = new (getModel(collection))().toObject();
    return rest;
}
