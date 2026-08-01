// Crash recovery, run once at startup. A job left in `running` when the process died can't be
// resumed, so we reconcile it against its file's persisted status: if the file reached a terminal
// success the job is completed, otherwise it's failed (the file's own status drives any retry).
import * as db from "../../database/index.js";
import * as job from "../job.js";
import * as logging from "../logging.js";
import * as processing from "../processing.js";
import { COLLECTION, JOB_TYPE, FILE_STATUS, RESULT_STATUS } from "shared/domain.js";

// The file statuses that mean a job of each type actually finished before the crash. A job type not
// listed here (e.g. SCAN_DIRECTORY) has no file outcome to judge against, so it's never treated as
// completed.
const SUCCESS_STATUSES_BY_JOB_TYPE = {
    [JOB_TYPE.TRANSCODE_FILE]: new Set([FILE_STATUS.transcoded, FILE_STATUS.replaced]),
    [JOB_TYPE.PROBE_FILE]: new Set([FILE_STATUS.queued, FILE_STATUS.ignored]),
};

export function clearProbeOwnerForJob(file, probeJobId) {
    return file?.activeProbeJobId === probeJobId ? { ...file, activeProbeJobId: null } : file;
}

// Whether an interrupted job actually finished its work before the crash, judged by its file's
// status (the only durable record once the in-memory job state is gone).
async function jobCompletedBeforeCrash(runningJob) {
    const successStatuses = SUCCESS_STATUSES_BY_JOB_TYPE[runningJob.type];
    if (!successStatuses) {
        return false;
    }

    const file = await db.get(COLLECTION.files, runningJob.payload?.fileId);
    if (!file || file.activeJobId || !successStatuses.has(file.status)) {
        return false;
    }
    if (runningJob.type !== JOB_TYPE.TRANSCODE_FILE) {
        return true;
    }
    return (file.transcodeResults || []).some(
        (result) =>
            result.settingId === runningJob.payload?.settingId &&
            [RESULT_STATUS.done, RESULT_STATUS.replaced].includes(result.status),
    );
}

export async function recoverInterruptedJobs() {
    const runningJobs = await job.listRunning();
    if (runningJobs.length > 0) {
        logging.log("queue", `recovering ${runningJobs.length} interrupted job(s) from previous run`);
    }

    for (const runningJob of runningJobs) {
        const completed = await jobCompletedBeforeCrash(runningJob);
        if (runningJob.type === JOB_TYPE.PROBE_FILE && runningJob.payload?.fileId) {
            await processing.updateFileLifecycle(runningJob.payload.fileId, (file) =>
                clearProbeOwnerForJob(file, runningJob.jobId),
            );
        }
        if (completed) {
            await job.completeIfRunning(runningJob.jobId);
        } else {
            await job.failIfActive(runningJob.jobId, "Interrupted by server restart");
        }
    }
}
