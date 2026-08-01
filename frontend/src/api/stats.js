"use client";

import * as client from "./client.js";

export function get(options) {
    return client.get("stats", options);
}
