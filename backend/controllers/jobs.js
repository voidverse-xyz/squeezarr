// Jobs controller — the read surface over the queue's job documents. The queue itself is
// driven by services/event.js; this only exposes the list the dashboard renders.
import { jobService } from "../services/index.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../utilities/constants.js";
import { getResult } from "shared/response.js";

export async function list({ limit } = {}) {
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit) || DEFAULT_PAGE_SIZE));
    const jobs = await jobService.list({ limit: pageSize });
    return getResult(true, "jobs_listed", { items: jobs, total: jobs.length });
}
