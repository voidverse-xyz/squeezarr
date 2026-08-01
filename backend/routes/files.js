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
        let json = req.query ?? {};
        let status = sanitize.enum(json.status, STATUS_FILTERS);
        let page = sanitize.int(json.page, { min: 1, fallback: 1 });
        let limit = sanitize.int(json.limit, { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });

        let result = await filesController.list({ status, page, limit });

        res.send(result);
    }),
);

router.post(
    "/delete",
    trackRequestHandler(async (req, res) => {
        let json = req.body ?? {};
        let fileId = sanitize.text(json.fileId);

        let result = await filesController.remove(fileId);

        res.send(result);
    }),
);

router.post(
    "/requeue",
    trackRequestHandler(async (req, res) => {
        let json = req.body ?? {};
        let fileId = sanitize.text(json.fileId);

        let result = await filesController.requeue(fileId);

        res.send(result);
    }),
);

router.post(
    "/stop",
    trackRequestHandler(async (req, res) => {
        let json = req.body ?? {};
        let fileId = sanitize.text(json.fileId);

        let result = await filesController.stop(fileId);

        res.send(result);
    }),
);

router.post(
    "/replace",
    trackRequestHandler(async (req, res) => {
        let json = req.body ?? {};
        let fileId = sanitize.text(json.fileId);
        let settingId = sanitize.text(json.settingId);

        let result = await filesController.replace(fileId, settingId);

        res.send(result);
    }),
);

router.post(
    "/output",
    trackRequestHandler(async (req, res) => {
        let json = req.body ?? {};
        let fileId = sanitize.text(json.fileId);
        let settingId = sanitize.text(json.settingId);

        let result = await filesController.deleteOutput(fileId, settingId);

        res.send(result);
    }),
);

export default router;
