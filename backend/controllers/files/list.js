// Read side of the "files" resource: the paginated, status-filtered listing the dashboard renders,
// plus the per-bucket counts shown on the stat cards. Returns the response envelope (getResult);
// there is no auth/role argument — this is a single-user, single-instance app (see AGENTS.md).
import * as db from "../../database/index.js";
import { COLLECTION, FILE_STATUS } from "shared/domain.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../utilities/constants.js";
import { getResult } from "shared/response.js";

function isSuccessStatus(status) {
    return status === FILE_STATUS.transcoded || status === FILE_STATUS.replaced;
}

// "queued" is a UI bucket covering both pending (pre-probe) and queued files.
function isWaitingStatus(status) {
    return status === FILE_STATUS.pending || status === FILE_STATUS.queued;
}

// Tally each file into a UI bucket: "done" combines transcoded + replaced; "queued" combines
// pending + queued; the rest map straight through by status.
function countByBucket(files) {
    const counts = { queued: 0, processing: 0, done: 0, failed: 0, rejected: 0, stopped: 0, ignored: 0 };
    for (const file of files) {
        if (isSuccessStatus(file.status)) {
            counts.done++;
        } else if (isWaitingStatus(file.status)) {
            counts.queued++;
        } else if (counts[file.status] !== undefined) {
            counts[file.status]++;
        }
    }
    return counts;
}

// Filter to a single UI bucket; the "done"/"queued" buckets each span two raw statuses.
function filterByStatus(files, status) {
    if (!status) {
        return files;
    }
    if (status === "done") {
        return files.filter((f) => isSuccessStatus(f.status));
    }
    if (status === "queued") {
        return files.filter((f) => isWaitingStatus(f.status));
    }
    return files.filter((f) => f.status === status);
}

export async function list({ status, page, limit } = {}) {
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit) || DEFAULT_PAGE_SIZE));

    const allFiles = await db.getAll(COLLECTION.files);
    const counts = countByBucket(allFiles);

    const filtered = filterByStatus(allFiles, status);
    filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    const total = filtered.length;
    const items = filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    return getResult(true, "files_listed", {
        items,
        total,
        stats: { ...counts, total: allFiles.length },
        page: pageNum,
        limit: pageSize,
    });
}
