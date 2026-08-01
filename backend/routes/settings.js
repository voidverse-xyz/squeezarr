import { Router } from "express";
import { settingsController } from "../controllers/index.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

router.get(
    "/",
    trackRequestHandler(async (_req, res) => {
        const result = await settingsController.get();

        res.send(result);
    }),
);

router.put(
    "/",
    trackRequestHandler(async (req, res) => {
        const settings = req.body ?? {};

        // The settings payload is deeply nested; the controller validates it (settingsValidationService)
        // and returns a getResult error on bad input.
        const result = await settingsController.save(settings);

        res.send(result);
    }),
);

export default router;
