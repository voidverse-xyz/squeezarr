"use client";

import * as client from "./client.js";

export function login(password, options) {
    return client.post("auth/login", { password }, options);
}

export function logout(options) {
    return client.post("auth/logout", undefined, options);
}

export function session(options) {
    return client.get("auth/session", options);
}
