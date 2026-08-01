"use client";

import * as client from "./client.js";

// Path strings must match the backend's mounted routes exactly — there's no shared constant
// between the layers, so a typo here lands in the normal failure envelope instead of failing
// at compile time (see backend/routes/files.js, mounted under /api/files).
export function list({ status, limit } = {}, options) {
    const params = new URLSearchParams();
    if (limit) {
        params.set("limit", limit);
    }
    if (status && status !== "all") {
        params.set("status", status);
    }
    const qs = params.toString();
    return client.get(`files${qs ? `?${qs}` : ""}`, options);
}

export function remove(fileId, options) {
    return client.post("files/delete", { fileId }, options);
}

export function deleteOutput(fileId, settingId, options) {
    return client.post("files/output", { fileId, settingId }, options);
}

export function replace(fileId, settingId, options) {
    return client.post("files/replace", { fileId, settingId }, options);
}

export function requeue(fileId, options) {
    return client.post("files/requeue", { fileId }, options);
}

export function stop(fileId, options) {
    return client.post("files/stop", { fileId }, options);
}
