import { Router } from "express";
import { sanitize } from "../utilities/sanitize.js";
import { authController } from "../controllers/index.js";
import { authService } from "../services/index.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

function clientKey(req) {
    return req.ip || req.socket?.remoteAddress || "unknown";
}

router.post(
    "/login",
    trackRequestHandler(async (req, res) => {
        const json = req.body ?? {};
        const password = sanitize.text(json.password);
        const result = authController.login(password, clientKey(req));

        res.status(result.output === "too_many_attempts" ? 429 : result.success ? 200 : 401).send(result);
    }),
);

router.post(
    "/logout",
    trackRequestHandler(async (req, res) => {
        const token = authService.extractBearerToken(req.headers.authorization);
        const result = authController.logout(token);

        res.send(result);
    }),
);

router.get(
    "/session",
    trackRequestHandler(async (req, res) => {
        const token = authService.extractBearerToken(req.headers.authorization);
        const result = authController.session(token);

        res.status(result.success ? 200 : 401).send(result);
    }),
);

export default router;
