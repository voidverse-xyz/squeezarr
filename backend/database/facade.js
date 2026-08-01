import { getModel, idFieldFor } from "./models.js";

// The collection-keyed CRUD facade — keyed off each collection's application-id field, so
// `db.get(COLLECTION.files, fileId)` → `findOne({ fileId })` and callers see `fileId`, never
// Mongo's `_id`. These assume the connection is open: the backend calls `db.connect()` once at
// boot (before anything serves), and Mongoose buffers/keeps the single connection thereafter —
// so there's no per-call `await connect()` here.

// Reads project `_id` away at the source: MongoDB always stamps an ObjectId `_id` on a root
// document (it can't be disabled — only `__v` is), and the app never reads it, so it's excluded
// here rather than stripped afterwards. Writes drop it in `add` (see below).
const EXCLUDE_ID = { _id: 0 };

// Same-document mutations are FIFO within this one monitor process. Different documents retain
// full concurrency; no database lock document or cross-instance coordination is involved.
const mutationTails = new Map();

async function withDocumentMutation(collection, id, operation) {
    const key = JSON.stringify([collection, id]);
    const previous = mutationTails.get(key) || Promise.resolve();
    let releaseTurn;
    const turn = new Promise((resolve) => {
        releaseTurn = resolve;
    });
    const tail = previous.then(() => turn);
    mutationTails.set(key, tail);
    await previous;
    try {
        return await operation();
    } finally {
        releaseTurn();
        if (mutationTails.get(key) === tail) {
            mutationTails.delete(key);
        }
    }
}

async function replaceUnlocked(collection, id, document) {
    const Model = getModel(collection);
    const idField = idFieldFor(collection);
    // Build through the model so schema defaults/casting apply, stamping the id field with the
    // app id. Drop Mongo's `_id` from the replacement: on insert Mongo generates a fresh one,
    // on update the existing (immutable) `_id` is preserved — either way the app never writes it.
    const built = new Model({ ...document, [idField]: id }).toObject();
    delete built._id;
    await Model.replaceOne({ [idField]: id }, built, { upsert: true });
    return true;
}

export async function add(collection, id, document) {
    return withDocumentMutation(collection, id, () => replaceUnlocked(collection, id, document));
}

export async function get(collection, id) {
    return getModel(collection)
        .findOne({ [idFieldFor(collection)]: id }, EXCLUDE_ID)
        .lean();
}

// The callback runs while this document's mutation turn is held. It may await unrelated work, but
// must not recursively mutate the same collection/id (that would wait on its own FIFO turn).
export async function update(collection, id, updateFn) {
    return withDocumentMutation(collection, id, async () => {
        const existing = await get(collection, id);
        const updated = await updateFn(existing);
        if (updated != null) {
            await replaceUnlocked(collection, id, updated);
        }
        return updated;
    });
}

// Shallow-merge `fields` onto an existing doc — the common "set these few fields" case. No-op if
// the doc is gone (returns null) rather than upserting a partial. Reach for `update` directly when
// the new value must be computed from the old doc (array transforms, conditionals, increments).
export async function patch(collection, id, fields) {
    return update(collection, id, (existing) => (existing ? { ...existing, ...fields } : existing));
}

export async function exists(collection, id) {
    return (await getModel(collection).exists({ [idFieldFor(collection)]: id })) != null;
}

export async function remove(collection, id) {
    return withDocumentMutation(collection, id, async () => {
        const result = await getModel(collection).deleteOne({ [idFieldFor(collection)]: id });
        return result.deletedCount > 0;
    });
}

export async function getAll(collection) {
    return getModel(collection).find({}, EXCLUDE_ID).lean();
}

export async function find(collection, filter, { sort, limit } = {}) {
    let query = getModel(collection).find(filter, EXCLUDE_ID).lean();
    if (sort) {
        query = query.sort(sort);
    }
    if (limit) {
        query = query.limit(limit);
    }
    return query;
}
