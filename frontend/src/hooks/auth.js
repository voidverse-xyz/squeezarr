"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { authApi } from "@/api";
import * as apiClient from "@/api/client";
import { createLatestRequest } from "@/lib/latest-request";
import { getDataFromResult } from "@/lib/utils";

const AUTH_TOKEN_KEY = "squeezarr.auth.token";

function obsoleteAuthResult() {
    return {
        success: false,
        output: "request_cancelled",
        error: { kind: apiClient.API_ERROR_KIND.cancelled, status: null },
        status: null,
    };
}

export function useAuthState() {
    const [ready, setReady] = useState(false);
    const [token, setToken] = useState("");
    const [expiresAt, setExpiresAt] = useState(null);
    const [unavailable, setUnavailable] = useState(false);
    const latestRef = useRef(createLatestRequest());

    const clearSession = useCallback(() => {
        latestRef.current.cancel();
        apiClient.setAuthToken("");
        sessionStorage.removeItem(AUTH_TOKEN_KEY);
        setToken("");
        setExpiresAt(null);
        setUnavailable(false);
        setReady(true);
    }, []);

    useEffect(() => {
        apiClient.setUnauthorizedHandler(clearSession);
        return () => apiClient.setUnauthorizedHandler(null);
    }, [clearSession]);

    const hydrate = useCallback(async () => {
        const request = latestRef.current.start();
        const storedToken = sessionStorage.getItem(AUTH_TOKEN_KEY);
        if (!storedToken) {
            if (request.isLatest()) {
                setUnavailable(false);
                setReady(true);
            }
            return;
        }

        setReady(false);
        apiClient.setAuthToken(storedToken);
        const result = await authApi.session({ signal: request.signal });
        if (!request.isLatest()) return;
        if (result?.success) {
            setToken(storedToken);
            setExpiresAt(getDataFromResult(result, { expiresAt: null }).expiresAt);
            setUnavailable(false);
        } else if (result?.status === 401) {
            clearSession();
            return;
        } else {
            // Keep both the bearer value and storage intact. The monitor may simply be restarting.
            setUnavailable(true);
        }
        setReady(true);
    }, [clearSession]);

    useEffect(() => {
        const latest = latestRef.current;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional client-only session hydration
        hydrate();
        return () => latest.cancel();
    }, [hydrate]);

    const login = useCallback(async (password) => {
        const request = latestRef.current.start();
        const result = await authApi.login(password, { signal: request.signal });
        if (!request.isLatest()) return obsoleteAuthResult();
        const data = getDataFromResult(result, null);
        if (result?.success && data?.token) {
            apiClient.setAuthToken(data.token);
            sessionStorage.setItem(AUTH_TOKEN_KEY, data.token);
            setToken(data.token);
            setExpiresAt(data.expiresAt ?? null);
            setUnavailable(false);
            setReady(true);
        }
        return result;
    }, []);

    const logout = useCallback(async () => {
        const request = latestRef.current.start();
        const result = await authApi.logout({ signal: request.signal });
        if (request.isLatest()) clearSession();
        return result;
    }, [clearSession]);

    return {
        ready,
        authenticated: !!token,
        unavailable,
        expiresAt,
        login,
        logout,
        retry: hydrate,
        clearSession,
    };
}
