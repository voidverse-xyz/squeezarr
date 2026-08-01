import { Router } from "express";
import { settingsController } from "../controllers/index.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

router.get(
    "/",
    trackRequestHandler(async (_req, res) => {
        let result = await settingsController.get();

        res.send(result);
    }),
);

router.put(
    "/",
    trackRequestHandler(async (req, res) => {
        let json = req.body ?? {};

        // The settings payload is deeply nested; the controller validates it (settingsValidationService)
        // and returns a getResult error on bad input.
        let result = await settingsController.save(json);

        res.send(result);
    }),
);

export default router;
