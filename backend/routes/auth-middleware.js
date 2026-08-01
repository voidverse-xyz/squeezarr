import { getResult } from "shared/response.js";
import { authService } from "../services/index.js";

function sendAuthFailure(res, output) {
    res.status(401).send(getResult(false, output));
}

export function requireAuth(req, res, next) {
    const token = authService.extractBearerToken(req.headers.authorization);
    const result = authService.verifySessionToken(token);
    if (result.error) {
        sendAuthFailure(res, result.error);
        return;
    }
    req.auth = result.value;
    next();
}
