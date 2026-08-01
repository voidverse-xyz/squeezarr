import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import * as auth from "../services/auth.js";
import { apiRouter } from "../routes/index.js";

function restoreEnv(snapshot) {
    for (const key of [auth.ADMIN_PASSWORD_ENV, auth.RUNNER_TOKEN_ENV]) {
        if (snapshot[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = snapshot[key];
        }
    }
}

async function withEnv(values, fn) {
    const snapshot = {
        [auth.ADMIN_PASSWORD_ENV]: process.env[auth.ADMIN_PASSWORD_ENV],
        [auth.RUNNER_TOKEN_ENV]: process.env[auth.RUNNER_TOKEN_ENV],
    };
    auth.resetAuthState();
    try {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        await fn();
    } finally {
        auth.resetAuthState();
        restoreEnv(snapshot);
    }
}

async function withApi(fn) {
    const app = express();
    app.use(express.json());
    app.use(
        "/api",
        apiRouter({
            readiness: () => ({
                ready: true,
                status: "ready",
                subsystems: { mongod: "ready", database: "ready", queue: "ready", http: "ready" },
            }),
        }),
    );
    const server = app.listen(0);
    try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("auth env validation reports the required monitor and runner secrets", () =>
    withEnv({}, () => {
        assert.deepEqual(auth.validateMonitorEnv({}), [auth.ADMIN_PASSWORD_ENV, auth.RUNNER_TOKEN_ENV]);
        assert.deepEqual(auth.validateRunnerEnv({}), [auth.RUNNER_TOKEN_ENV]);
        assert.deepEqual(
            auth.validateMonitorEnv({
                [auth.ADMIN_PASSWORD_ENV]: "admin",
                [auth.RUNNER_TOKEN_ENV]: "runner",
            }),
            [],
        );
    }));

test("password login returns a signed session token that verifies until expiry", () =>
    withEnv({ [auth.ADMIN_PASSWORD_ENV]: "admin-password" }, () => {
        const result = auth.authenticatePassword("admin-password", "client", 1_000);

        assert.ok(result.value?.token);
        assert.equal(result.value.expiresAt, 1_000 + auth.SESSION_TTL_MS);

        const verified = auth.verifySessionToken(result.value.token, 2_000);
        assert.equal(verified.error, undefined);
        assert.equal(verified.value.expiresAt, result.value.expiresAt);
    }));

test("session verification rejects tampered, expired, and revoked tokens", () =>
    withEnv({ [auth.ADMIN_PASSWORD_ENV]: "admin-password" }, () => {
        const result = auth.authenticatePassword("admin-password", "client", 1_000);
        const token = result.value.token;
        const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

        assert.equal(auth.verifySessionToken(tampered, 2_000).error, "unauthorized");
        assert.equal(auth.verifySessionToken(token, 1_000 + auth.SESSION_TTL_MS + 1).error, "expired_token");

        assert.equal(auth.revokeSessionToken(token, 2_000), true);
        assert.equal(auth.verifySessionToken(token, 2_001).error, "unauthorized");
    }));

test("rotating the startup epoch invalidates every pre-restart session", () =>
    withEnv({ [auth.ADMIN_PASSWORD_ENV]: "admin-password" }, () => {
        const token = auth.authenticatePassword("admin-password", "client", 1_000).value.token;
        assert.equal(auth.verifySessionToken(token, 2_000).error, undefined);

        auth.rotateSessionEpoch();

        assert.equal(auth.verifySessionToken(token, 2_001).error, "unauthorized");
    }));

test("wrong passwords are throttled per client key", () =>
    withEnv({ [auth.ADMIN_PASSWORD_ENV]: "admin-password" }, () => {
        for (let i = 0; i < auth.LOGIN_MAX_ATTEMPTS - 1; i++) {
            assert.equal(auth.authenticatePassword("wrong", "client", 1_000 + i).error, "unauthorized");
        }

        assert.equal(
            auth.authenticatePassword("wrong", "client", 1_000 + auth.LOGIN_MAX_ATTEMPTS).error,
            "too_many_attempts",
        );
        assert.equal(auth.authenticatePassword("admin-password", "client", 2_000).error, "too_many_attempts");
        assert.equal(
            auth.authenticatePassword("admin-password", "other-client", 2_000).value.expiresAt,
            2_000 + auth.SESSION_TTL_MS,
        );
    }));

test("runner authorization accepts only the configured runner token", () =>
    withEnv({ [auth.RUNNER_TOKEN_ENV]: "runner-token" }, () => {
        assert.equal(auth.verifyRunnerAuthorization("Bearer runner-token"), true);
        assert.equal(auth.verifyRunnerAuthorization("Bearer wrong-token"), false);
        assert.equal(auth.verifyRunnerAuthorization(""), false);
    }));

test("api health is public, protected routes need auth, and login/session/logout work", () =>
    withEnv({ [auth.ADMIN_PASSWORD_ENV]: "admin-password", [auth.RUNNER_TOKEN_ENV]: "runner-token" }, () =>
        withApi(async (baseUrl) => {
            const health = await fetch(`${baseUrl}/api/health`);
            assert.equal(health.status, 200);
            assert.equal((await health.json()).success, true);

            const protectedResponse = await fetch(`${baseUrl}/api/stats`);
            assert.equal(protectedResponse.status, 401);
            assert.equal((await protectedResponse.json()).output, "unauthorized");

            const login = await fetch(`${baseUrl}/api/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: "admin-password" }),
            });
            assert.equal(login.status, 200);
            const loginBody = await login.json();
            assert.equal(loginBody.success, true);
            assert.ok(loginBody.data.token);

            const session = await fetch(`${baseUrl}/api/auth/session`, {
                headers: { Authorization: `Bearer ${loginBody.data.token}` },
            });
            assert.equal(session.status, 200);
            assert.equal((await session.json()).success, true);

            const logout = await fetch(`${baseUrl}/api/auth/logout`, {
                method: "POST",
                headers: { Authorization: `Bearer ${loginBody.data.token}` },
            });
            assert.equal(logout.status, 200);

            const revokedSession = await fetch(`${baseUrl}/api/auth/session`, {
                headers: { Authorization: `Bearer ${loginBody.data.token}` },
            });
            assert.equal(revokedSession.status, 401);
            assert.equal((await revokedSession.json()).output, "unauthorized");
        }),
    ));
