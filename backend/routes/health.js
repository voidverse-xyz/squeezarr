import { Router } from "express";
import { getResult } from "shared/response.js";
import { readinessService } from "../services/index.js";

const router = Router();

router.get("/", function getHealth(_req, res) {
    const state = readinessService.getReadiness();
    const result = getResult(state.ready, state.ready ? "ok" : "not_ready", state);

    res.status(state.ready ? 200 : 503).send(result);
});

export default router;
