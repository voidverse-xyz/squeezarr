"use client";

import { getResult } from "shared/response.js";
import { REQUEST_TIMEOUT_MS } from "../lib/constants.js";

export const API_ERROR_KIND = {
    api: "api",
    http: "http",
    transport: "transport",
    parse: "parse",
    timeout: "timeout",
    cancelled: "cancelled",
};

let authToken = "";
let unauthorizedHandler = null;

export function setAuthToken(token) {
    authToken = token || "";
}

export function setUnauthorizedHandler(handler) {
    unauthorizedHandler = typeof handler === "function" ? handler : null;
}

function failure(output, kind, status = null) {
    return { ...getResult(false, output), error: { kind, status }, status };
}

async function request(method, path, body, { signal: callerSignal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    let abortKind = null;
    const cancel = () => {
        if (!controller.signal.aborted) {
            abortKind = API_ERROR_KIND.cancelled;
            controller.abort();
        }
    };
    if (callerSignal?.aborted) {
        cancel();
    } else {
        callerSignal?.addEventListener("abort", cancel, { once: true });
    }
    const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
            abortKind = API_ERROR_KIND.timeout;
            controller.abort();
        }
    }, deadlineMs);

    // A request owns the exact bearer it was dispatched with. A 401 from this generation may only
    // invalidate that same session, never a token installed while the request was in flight.
    const requestToken = authToken;
    try {
        const headers = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (requestToken) headers.Authorization = `Bearer ${requestToken}`;

        let response;
        try {
            response = await fetch(`/api/${path}`, {
                method,
                headers: Object.keys(headers).length ? headers : undefined,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (error) {
            if (abortKind) {
                return failure(
                    abortKind === API_ERROR_KIND.timeout ? "request_timeout" : "request_cancelled",
                    abortKind,
                );
            }
            return failure(error.message, API_ERROR_KIND.transport);
        }

        let result;
        try {
            result = await response.json();
        } catch (error) {
            if (abortKind) {
                return failure(
                    abortKind === API_ERROR_KIND.timeout ? "request_timeout" : "request_cancelled",
                    abortKind,
                    response.status,
                );
            }
            return failure(
                response.statusText || error.message || "invalid_response",
                API_ERROR_KIND.parse,
                response.status,
            );
        }
        if (abortKind) {
            return failure(
                abortKind === API_ERROR_KIND.timeout ? "request_timeout" : "request_cancelled",
                abortKind,
                response.status,
            );
        }

        if (!response.ok) {
            const failed = {
                ...(result?.success === false ? result : getResult(false, result?.output || response.statusText)),
                error: { kind: API_ERROR_KIND.http, status: response.status },
                status: response.status,
            };
            if (response.status === 401 && path !== "auth/login" && authToken === requestToken) {
                unauthorizedHandler?.(failed.output || "unauthorized");
            }
            return failed;
        }
        if (result?.success === false) {
            return { ...result, error: { kind: API_ERROR_KIND.api, status: response.status }, status: response.status };
        }
        return { ...result, status: response.status };
    } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", cancel);
    }
}

export function get(path, options) {
    return request("GET", path, undefined, options);
}

export function post(path, body, options) {
    return request("POST", path, body, options);
}

export function put(path, body, options) {
    return request("PUT", path, body, options);
}
