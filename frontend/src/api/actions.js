"use client";

import * as client from "./client.js";

export function getProcessing(options) {
    return client.get("actions/processing", options);
}

export function setProcessing(paused, options) {
    return client.post("actions/processing", { paused }, options);
}

export function scan(options) {
    return client.post("actions/scan", undefined, options);
}
