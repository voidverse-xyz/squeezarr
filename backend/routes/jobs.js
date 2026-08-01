import { Router } from "express";
import { sanitize } from "../utilities/sanitize.js";
import { jobsController } from "../controllers/index.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../utilities/constants.js";
import { trackRequestHandler } from "../services/shutdown.js";

const router = Router();

router.get(
    "/",
    trackRequestHandler(async (req, res) => {
        let json = req.query ?? {};
        let limit = sanitize.int(json.limit, { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });

        let result = await jobsController.list({ limit });

        res.send(result);
    }),
);

export default router;
