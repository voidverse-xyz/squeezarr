import { Router } from "express";
import { sanitize } from "../utilities/sanitize.js";
import { actionsController } from "../controllers/index.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

router.get(
    "/processing",
    trackRequestHandler(async (_req, res) => {
        const result = await actionsController.getProcessing();

        res.send(result);
    }),
);

router.post(
    "/processing",
    trackRequestHandler(async (req, res) => {
        const body = req.body ?? {};
        const paused = sanitize.bool(body.paused);

        const result = await actionsController.setProcessing(paused);

        res.send(result);
    }),
);

router.post(
    "/scan",
    trackRequestHandler(async (_req, res) => {
        const result = await actionsController.scan();

        res.send(result);
    }),
);

export default router;
