import { Router } from "express";
import { sanitize } from "../utilities/sanitize.js";
import { filesController } from "../controllers/index.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../utilities/constants.js";
import { FILE_STATUS } from "shared/domain.js";
import { trackRequestHandler } from "../services/shutdown.js";

// Status values the list can be filtered by: every file status plus the "done" aggregate. "All" is
// sent as no status at all (see controllers/files/list and frontend api/files.list).
const STATUS_FILTERS = [...Object.values(FILE_STATUS), "done"];

const router = Router();

router.get(
    "/",
    trackRequestHandler(async (req, res) => {
        const query = req.query ?? {};
        const status = sanitize.enum(query.status, STATUS_FILTERS);
        const page = sanitize.int(query.page, { min: 1, fallback: 1 });
        const limit = sanitize.int(query.limit, { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });

        const result = await filesController.list({ status, page, limit });

        res.send(result);
    }),
);

router.post(
    "/delete",
    trackRequestHandler(async (req, res) => {
        const body = req.body ?? {};
        const fileId = sanitize.text(body.fileId);

        const result = await filesController.remove(fileId);

        res.send(result);
    }),
);

router.post(
    "/requeue",
    trackRequestHandler(async (req, res) => {
        const body = req.body ?? {};
        const fileId = sanitize.text(body.fileId);

        const result = await filesController.requeue(fileId);

        res.send(result);
    }),
);

router.post(
    "/stop",
    trackRequestHandler(async (req, res) => {
        const body = req.body ?? {};
        const fileId = sanitize.text(body.fileId);

        const result = await filesController.stop(fileId);

        res.send(result);
    }),
);

router.post(
    "/replace",
    trackRequestHandler(async (req, res) => {
        const body = req.body ?? {};
        const fileId = sanitize.text(body.fileId);
        const settingId = sanitize.text(body.settingId);

        const result = await filesController.replace(fileId, settingId);

        res.send(result);
    }),
);

router.post(
    "/output",
    trackRequestHandler(async (req, res) => {
        const body = req.body ?? {};
        const fileId = sanitize.text(body.fileId);
        const settingId = sanitize.text(body.settingId);

        const result = await filesController.deleteOutput(fileId, settingId);

        res.send(result);
    }),
);

export default router;
