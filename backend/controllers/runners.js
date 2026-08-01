// Runners controller — surface for the connected transcode runners, so the dashboard can show
// who is transcoding and each runner's last heartbeat, and pause/resume an individual runner.
// Runners aren't persisted; the live registry lives in the monitor's runner pool
// (services/runnerpool.js).
import { runnerpoolService } from "../services/index.js";
import { getResult } from "shared/response.js";

export async function list() {
    // Only connected runners are tracked (a disconnect drops them), so just order by activity.
    const runners = runnerpoolService.list().sort((a, b) => (b.lastHeartbeatAt || 0) - (a.lastHeartbeatAt || 0));

    return getResult(true, "runners_loaded", { runners });
}

// Pause/resume one runner so it stops (or resumes) taking new jobs; a paused runner finishes
// any job already in flight. No-op-safe: a runner that has since disconnected returns a failure.
export async function setPaused(runnerId, paused) {
    if (!runnerpoolService.setPaused(runnerId, paused)) {
        return getResult(false, "runner_not_found");
    }
    return getResult(true, paused ? "runner_paused" : "runner_resumed");
}
