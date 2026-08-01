import { Router } from "express";
import { sanitize } from "../utilities/sanitize.js";
import { runnersController } from "../controllers/index.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

router.get(
    "/",
    trackRequestHandler(async (_req, res) => {
        let result = await runnersController.list();

        res.send(result);
    }),
);

router.post(
    "/pause",
    trackRequestHandler(async (req, res) => {
        let json = req.body ?? {};
        let runnerId = sanitize.text(json.runnerId);
        let paused = sanitize.bool(json.paused);

        let result = await runnersController.setPaused(runnerId, paused);

        res.send(result);
    }),
);

export default router;
