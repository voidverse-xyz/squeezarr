import { Router } from "express";
import { statsController } from "../controllers/index.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

router.get(
    "/",
    trackRequestHandler(async (_req, res) => {
        let result = await statsController.get();

        res.send(result);
    }),
);

export default router;
