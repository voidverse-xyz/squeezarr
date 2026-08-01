// Runner metrics — the system snapshot a runner reports to the monitor so the Workers UI can show
// a live view of each node. Two kinds of data: static identity sent once on register
// (collectStaticInfo), and a periodic heartbeat carrying CPU/mem/load/uptime/GPU (the metrics
// timer). This module owns the sampling and the heartbeat timer; the orchestrator hands it the
// `send` function and the runnerId so it stays free of any socket/connection concern.
import os from "os";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { RUNNER_HEARTBEAT_MS } from "../../utilities/constants.js";

// Best-effort GPU query budget — nvidia-smi is killed (and the metric dropped) past this.
const GPU_QUERY_TIMEOUT_MS = 2000;

// Display name for this node in the Workers UI. Defaults to the OS hostname, but a deployment can
// override it via the NODE_NAME env var (e.g. a docker-compose `environment:` entry) so each
// container gets a stable, human-friendly label instead of a random container hostname.
const NODE_NAME = process.env.NODE_NAME?.trim() || os.hostname();

// This runner's app version — reported once on register so the Workers UI can show it. Read from
// the backend package.json (this file is backend/services/runner/metrics.js → ../../package.json).
const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    } catch {
        return "unknown";
    }
})();

// Static identity, sent once on register.
export function collectStaticInfo() {
    return {
        hostname: NODE_NAME,
        cores: os.cpus().length,
        platform: os.platform(),
        arch: os.arch(),
        version: VERSION,
    };
}

// Aggregate idle/total CPU ticks across all cores at this instant.
function cpuSample() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
        for (const t of Object.values(cpu.times)) {
            total += t;
        }
        idle += cpu.times.idle;
    }
    return { idle, total };
}

// CPU utilization % between two cpuSample() readings. Pure (no clock/IO) so it's unit-testable.
// Returns null when there's no prior sample or no elapsed ticks (first beat, or a too-fast poll).
export function computeCpuPercent(prev, cur) {
    if (!prev) {
        return null;
    }
    const idleDiff = cur.idle - prev.idle;
    const totalDiff = cur.total - prev.total;
    if (totalDiff <= 0) {
        return null;
    }
    return Math.round((1 - idleDiff / totalDiff) * 100);
}

let prevCpu = null;

// Once nvidia-smi is found absent we stop spawning it (null = unknown, false = absent, true = present).
let gpuAvailable = null;

// Best-effort NVIDIA GPU stats via nvidia-smi. Resolves null on any host without it (or a
// non-NVIDIA GPU) and caches that so we don't spawn a doomed process every heartbeat.
function collectGpu() {
    return new Promise((resolve) => {
        if (gpuAvailable === false) {
            return resolve(null);
        }

        let proc;
        try {
            proc = spawn("nvidia-smi", [
                "--query-gpu=utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ]);
        } catch {
            gpuAvailable = false;
            return resolve(null);
        }

        let out = "";
        let settled = false;
        const finish = (value) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }
        };
        const timer = setTimeout(() => {
            try {
                proc.kill("SIGKILL");
            } catch {}
            finish(null);
        }, GPU_QUERY_TIMEOUT_MS);

        proc.stdout.on("data", (chunk) => {
            out += chunk.toString();
        });
        proc.on("error", () => {
            gpuAvailable = false;
            finish(null);
        });
        proc.on("close", (code) => {
            if (code !== 0) {
                return finish(null);
            }
            gpuAvailable = true;
            // First GPU line: "<util>, <memUsedMiB>, <memTotalMiB>".
            const [util, memUsedMiB, memTotalMiB] = (out.trim().split("\n")[0] || "")
                .split(",")
                .map((s) => Number(s.trim()));
            if ([util, memUsedMiB, memTotalMiB].some(Number.isNaN)) {
                return finish(null);
            }
            const MiB = 1024 * 1024;
            finish({ util, memUsed: memUsedMiB * MiB, memTotal: memTotalMiB * MiB });
        });
    });
}

// A fresh metrics snapshot for one heartbeat. CPU% is a delta against the previous sample.
async function collectMetrics() {
    const cur = cpuSample();
    const cpuPercent = computeCpuPercent(prevCpu, cur);
    prevCpu = cur;
    const memTotal = os.totalmem();
    return {
        cpuPercent,
        memTotal,
        memUsed: memTotal - os.freemem(),
        loadAvg1: os.loadavg()[0],
        uptime: os.uptime(),
        gpu: await collectGpu(),
    };
}

// Connection-level heartbeat: runs the whole time the socket is open (idle or busy), so the
// monitor always has fresh metrics and a recent last-seen. `send` and `runnerId` are supplied by
// the orchestrator so this module never touches the socket directly.
let metricsTimer = null;

export function startMetricsHeartbeat(send, runnerId) {
    stopMetricsHeartbeat();
    prevCpu = null;
    const tick = async () => {
        send({ type: "heartbeat", runnerId, metrics: await collectMetrics() });
    };
    tick();
    metricsTimer = setInterval(tick, RUNNER_HEARTBEAT_MS);
}

export function stopMetricsHeartbeat() {
    if (metricsTimer) {
        clearInterval(metricsTimer);
        metricsTimer = null;
    }
}
