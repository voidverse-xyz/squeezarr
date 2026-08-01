"use client";

import * as client from "./client.js";

export function list({ limit } = {}, options) {
    return client.get(`jobs${limit ? `?limit=${limit}` : ""}`, options);
}
