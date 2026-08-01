import { Router } from "express";
import { sanitize } from "../utilities/sanitize.js";
import { runnersController } from "../controllers/index.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

router.get(
    "/",
    trackRequestHandler(async (_req, res) => {
        const result = await runnersController.list();

        res.send(result);
    }),
);

router.post(
    "/pause",
    trackRequestHandler(async (req, res) => {
        const body = req.body ?? {};
        const runnerId = sanitize.text(body.runnerId);
        const paused = sanitize.bool(body.paused);

        const result = await runnersController.setPaused(runnerId, paused);

        res.send(result);
    }),
);

export default router;
