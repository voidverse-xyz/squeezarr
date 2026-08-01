import crypto from "crypto";

export const ADMIN_PASSWORD_ENV = "SQUEEZARR_PASSWORD";
export const RUNNER_TOKEN_ENV = "SQUEEZARR_RUNNER_TOKEN";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 5;

const loginAttempts = new Map();
const revokedSessionIds = new Map();
let sessionEpoch = crypto.randomBytes(16).toString("base64url");

function readEnv(name, env = process.env) {
    return (env[name] || "").trim();
}

function missingRequired(names, env = process.env) {
    return names.filter((name) => !readEnv(name, env));
}

export function validateMonitorEnv(env = process.env) {
    return missingRequired([ADMIN_PASSWORD_ENV, RUNNER_TOKEN_ENV], env);
}

export function validateRunnerEnv(env = process.env) {
    return missingRequired([RUNNER_TOKEN_ENV], env);
}

export function getAdminPassword() {
    return readEnv(ADMIN_PASSWORD_ENV);
}

export function getRunnerToken() {
    return readEnv(RUNNER_TOKEN_ENV);
}

function safeEqual(a, b) {
    if (!a || !b) {
        return false;
    }
    const left = crypto.createHash("sha256").update(String(a)).digest();
    const right = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(left, right);
}

function signPayload(encodedPayload) {
    return crypto.createHmac("sha256", getAdminPassword()).update(encodedPayload).digest("base64url");
}

function createToken(now = Date.now()) {
    const expiresAt = now + SESSION_TTL_MS;
    const payload = {
        iat: now,
        exp: expiresAt,
        sid: crypto.randomBytes(16).toString("base64url"),
        epoch: sessionEpoch,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return { token: `${encodedPayload}.${signPayload(encodedPayload)}`, expiresAt };
}

function parseToken(token) {
    if (!token || typeof token !== "string") {
        return null;
    }
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return null;
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
        return null;
    }
    return { encodedPayload: parts[0], signature: parts[1], payload };
}

function pruneLoginAttempts(now) {
    for (const [key, entry] of loginAttempts) {
        if (entry.resetAt <= now && (!entry.blockedUntil || entry.blockedUntil <= now)) {
            loginAttempts.delete(key);
        }
    }
}

function pruneRevokedSessions(now) {
    for (const [sessionId, expiresAt] of revokedSessionIds) {
        if (expiresAt <= now) revokedSessionIds.delete(sessionId);
    }
}

function getAttemptEntry(clientKey, now) {
    const entry = loginAttempts.get(clientKey);
    if (!entry || entry.resetAt <= now) {
        return { count: 0, resetAt: now + LOGIN_WINDOW_MS, blockedUntil: 0 };
    }
    return entry;
}

export function authenticatePassword(password, clientKey = "unknown", now = Date.now()) {
    pruneLoginAttempts(now);

    const key = clientKey || "unknown";
    const entry = getAttemptEntry(key, now);
    if (entry.blockedUntil > now) {
        return { error: "too_many_attempts" };
    }

    if (!safeEqual(password, getAdminPassword())) {
        entry.count += 1;
        if (entry.count >= LOGIN_MAX_ATTEMPTS) {
            entry.blockedUntil = entry.resetAt;
        }
        loginAttempts.set(key, entry);
        return { error: entry.blockedUntil > now ? "too_many_attempts" : "unauthorized" };
    }

    loginAttempts.delete(key);
    return { value: createToken(now) };
}

export function extractBearerToken(header) {
    if (typeof header !== "string") {
        return "";
    }
    const parts = header.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
        return "";
    }
    return parts[1];
}

export function verifySessionToken(token, now = Date.now()) {
    pruneRevokedSessions(now);

    if (!token) return { error: "unauthorized" };

    const parsed = parseToken(token);
    if (!parsed) {
        return { error: "unauthorized" };
    }

    if (!safeEqual(parsed.signature, signPayload(parsed.encodedPayload))) {
        return { error: "unauthorized" };
    }

    const expiresAt = Number(parsed.payload.exp);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return { error: "expired_token" };
    if (parsed.payload.epoch !== sessionEpoch || !parsed.payload.sid || revokedSessionIds.has(parsed.payload.sid)) {
        return { error: "unauthorized" };
    }

    return { value: { expiresAt, issuedAt: Number(parsed.payload.iat) || null, sessionId: parsed.payload.sid } };
}

export function revokeSessionToken(token, now = Date.now()) {
    const verified = verifySessionToken(token, now);
    if (verified.error) {
        return false;
    }
    revokedSessionIds.set(verified.value.sessionId, verified.value.expiresAt);
    return true;
}

export function verifyRunnerAuthorization(header) {
    return safeEqual(extractBearerToken(header), getRunnerToken());
}

// Sessions intentionally do not survive a monitor restart. Rotating the in-memory epoch makes
// restart semantics explicit and ensures an acknowledged logout can never be undone by a restart.
export function rotateSessionEpoch() {
    sessionEpoch = crypto.randomBytes(16).toString("base64url");
    revokedSessionIds.clear();
}

export function resetAuthState() {
    loginAttempts.clear();
    revokedSessionIds.clear();
}
