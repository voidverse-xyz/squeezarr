import { getResult } from "shared/response.js";
import { authService } from "../services/index.js";

export function login(password, clientKey) {
    const result = authService.authenticatePassword(password, clientKey);
    if (result.error) {
        return getResult(false, result.error);
    }
    return getResult(true, "authenticated", result.value);
}

export function session(token) {
    const result = authService.verifySessionToken(token);
    if (result.error) {
        return getResult(false, result.error);
    }
    return getResult(true, "authenticated", result.value);
}

export function logout(token) {
    authService.revokeSessionToken(token);
    return getResult(true, "logged_out");
}
