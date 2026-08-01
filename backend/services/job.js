import crypto from "crypto";
import * as db from "../database/index.js";
import { COLLECTION, JOB_STATUS, JOB_TYPE } from "shared/domain.js";
import { MAX_PAGE_SIZE } from "../utilities/constants.js";

// List-ordering weight per job status: active work first, finished work last.
const STATUS_PRIORITY = {
    [JOB_STATUS.running]: 0,
    [JOB_STATUS.pending]: 1,
    [JOB_STATUS.failed]: 2,
    [JOB_STATUS.done]: 3,
};
// Any unrecognised status sorts alongside failed jobs.
const UNKNOWN_STATUS_PRIORITY = STATUS_PRIORITY[JOB_STATUS.failed];

export function createId() {
    return crypto.randomUUID();
}

// Persist a caller-reserved ID without an extra read. Requeue uses this to publish the probe ID on
// the file before the pending job becomes visible, then wakes the queue only after both writes.
export async function createPending(type, payload = {}, jobId = createId()) {
    await db.add(COLLECTION.jobs, jobId, { type, payload });
    return jobId;
}

export async function create(type, payload = {}) {
    const jobId = await createPending(type, payload);
    return db.get(COLLECTION.jobs, jobId);
}

export async function get(jobId) {
    return db.get(COLLECTION.jobs, jobId);
}

export async function list({ limit = MAX_PAGE_SIZE } = {}) {
    const jobs = await db.getAll(COLLECTION.jobs);

    jobs.sort((a, b) => {
        const priorityA = STATUS_PRIORITY[a.status] ?? UNKNOWN_STATUS_PRIORITY;
        const priorityB = STATUS_PRIORITY[b.status] ?? UNKNOWN_STATUS_PRIORITY;
        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }
        return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return limit ? jobs.slice(0, limit) : jobs;
}

export async function listPending() {
    return db.find(COLLECTION.jobs, { status: JOB_STATUS.pending }, { sort: { createdAt: 1 } });
}

export async function listRunning() {
    return db.find(COLLECTION.jobs, { status: JOB_STATUS.running });
}

export async function listOutstandingForFile(fileId) {
    return db.find(COLLECTION.jobs, {
        "payload.fileId": fileId,
        status: { $in: [JOB_STATUS.pending, JOB_STATUS.running] },
    });
}

export async function listActiveTranscodesForFile(fileId) {
    return db.find(COLLECTION.jobs, {
        type: JOB_TYPE.TRANSCODE_FILE,
        "payload.fileId": fileId,
        status: { $in: [JOB_STATUS.pending, JOB_STATUS.running] },
    });
}

// Fence a terminal transition to the expected current state. These helpers are intentionally
// no-ops for stale results and recovery callbacks.
export async function completeIfRunning(jobId) {
    let completed = false;
    await db.update(COLLECTION.jobs, jobId, (job) => {
        if (job?.status !== JOB_STATUS.running) {
            return job;
        }
        completed = true;
        return { ...job, status: JOB_STATUS.done, finishedAt: Date.now(), lifecyclePhase: "done" };
    });
    return completed;
}

export async function failIfActive(jobId, error) {
    let failed = false;
    await db.update(COLLECTION.jobs, jobId, (job) => {
        if (!job || ![JOB_STATUS.pending, JOB_STATUS.running].includes(job.status)) {
            return job;
        }
        failed = true;
        return { ...job, status: JOB_STATUS.failed, error, finishedAt: Date.now(), lifecyclePhase: "failed" };
    });
    return failed;
}

export function belongsToProbeGeneration(job, fileId, probeJobId) {
    return Boolean(
        job?.type === JOB_TYPE.TRANSCODE_FILE &&
        job.payload?.fileId === fileId &&
        job.payload?.probeJobId === probeJobId,
    );
}

export async function failProbeGeneration(fileId, probeJobId, error) {
    const active = await listActiveTranscodesForFile(fileId);
    let failed = 0;
    for (const activeJob of active) {
        if (belongsToProbeGeneration(activeJob, fileId, probeJobId) && (await failIfActive(activeJob.jobId, error))) {
            failed++;
        }
    }
    return failed;
}

export async function failOutstandingForFile(fileId, error, { exceptJobId = null } = {}) {
    const active = await db.find(COLLECTION.jobs, {
        "payload.fileId": fileId,
        status: { $in: [JOB_STATUS.pending, JOB_STATUS.running] },
    });
    let failed = 0;
    for (const activeJob of active) {
        if (activeJob.jobId === exceptJobId) {
            continue;
        }
        if (await failIfActive(activeJob.jobId, error)) {
            failed++;
        }
    }
    return failed;
}

// Move a job from pending → running, or return null if it's no longer pending
// (e.g. already claimed and handled earlier in this same batch).
export async function claim(jobId) {
    return db.update(COLLECTION.jobs, jobId, (job) =>
        job?.status === JOB_STATUS.pending ? { ...job, status: JOB_STATUS.running, startedAt: Date.now() } : null,
    );
}

// Return a just-claimed job to pending when shutdown wins before its handler/assignment starts.
// The state fence makes this harmless if another terminal transition already won.
export async function releaseClaim(jobId) {
    let released = false;
    await db.update(COLLECTION.jobs, jobId, (job) => {
        if (job?.status !== JOB_STATUS.running) {
            return job;
        }
        released = true;
        return { ...job, status: JOB_STATUS.pending, startedAt: null, lifecyclePhase: null };
    });
    return released;
}

export async function complete(jobId) {
    await completeIfRunning(jobId);
}

export async function fail(jobId, error) {
    await failIfActive(jobId, error);
}

export function collectProtectedLifecycleJobIds(files) {
    const protectedIds = new Set();
    for (const file of files || []) {
        for (const jobId of [
            file.activeJobId,
            file.activeProbeJobId,
            file.adjacentJournal?.jobId,
            file.overwriteJournal?.jobId,
        ]) {
            if (jobId) {
                protectedIds.add(jobId);
            }
        }
    }
    return protectedIds;
}

export function selectPrunableFinished(finished, files, keep = MAX_PAGE_SIZE) {
    const protectedIds = collectProtectedLifecycleJobIds(files);
    // Protected lifecycle records do not consume the history budget. They are coordination state,
    // not history, and remain until the owning file releases/settles them.
    return finished.filter((job) => !protectedIds.has(job.jobId)).slice(keep);
}

// Cap unreferenced finished-job history while retaining every terminal job still used as durable
// lifecycle evidence. A failure cleanup can outlive thousands of newer jobs; deleting its failed
// job would make releaseFailedOwner unable to prove durability and strand activeJobId forever.
export async function pruneFinished(keep = MAX_PAGE_SIZE) {
    const [finished, files] = await Promise.all([
        db.find(
            COLLECTION.jobs,
            { status: { $in: [JOB_STATUS.done, JOB_STATUS.failed] } },
            { sort: { finishedAt: -1 } },
        ),
        db.getAll(COLLECTION.files),
    ]);
    const excess = selectPrunableFinished(finished, files, keep);
    for (const staleJob of excess) {
        await db.remove(COLLECTION.jobs, staleJob.jobId);
    }
    return excess.length;
}

export async function updateProgress(jobId, progress) {
    await db.patch(COLLECTION.jobs, jobId, { progress }).catch(() => {});
}
