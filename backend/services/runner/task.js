// Runner task — the one in-flight ffmpeg job a runner drives at a time. It spawns ffmpeg, streams
// progress out of its stderr, keeps the tail of stderr for a failure message, and reports a
// `result` when the process exits. The orchestrator hands it the `send` function so this module
// stays free of any socket/connection concern; it owns only the `current` task state.
import { spawn } from "child_process";
import { existsSync } from "fs";
import os from "os";
import * as logging from "../logging.js";

// Grace period after SIGTERM before force-killing ffmpeg with SIGKILL.
const SIGKILL_GRACE_MS = 5000;

// Keep at most this much of ffmpeg's stderr (the tail) for the failure message — the real error
// is near the end, and a transcode can emit a lot of progress.
const STDERR_TAIL_LIMIT = 8192;

// One task at a time. Every callback closes over this task object; no callback reads mutable
// state belonging to a later assignment.
let current = null;

// Pull a meaningful error out of ffmpeg stderr for the failure message. ffmpeg floods stderr with
// progress (and rewrites the progress line in place with carriage returns, so the real error often
// shares a line with `frame=…`) — split on both \r and \n, drop progress lines, and keep the tail
// of what's left. Pure (string in, string out) so it's unit-testable. Returns "" when nothing
// useful remains (e.g. progress-only output), so the monitor falls back to the exit-code message.
export function ffmpegErrorTail(stderr, maxChars = 1000) {
    const meaningful = (stderr || "")
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line && !line.includes("time=") && !/^(frame=|size=)/.test(line));

    if (meaningful.length === 0) {
        return "";
    }

    const tail = meaningful.slice(-4).join("\n").trim();
    return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

function detach(task) {
    if (!task.proc) {
        return;
    }
    task.proc.off("close", task.onClose);
    task.proc.off("error", task.onError);
    task.proc.stderr?.off("data", task.onStderr);
}

// The sole settlement path for every task outcome. `emit=false` is connection-loss abort: the
// monitor owns recovery after the socket closes, so this runner must not report a competing result.
function finish(task, { exitCode = -1, error, emit = true } = {}) {
    if (task.settled) {
        return false;
    }
    task.settled = true;
    if (task.killTimer) {
        clearTimeout(task.killTimer);
        task.killTimer = null;
    }
    detach(task);
    if (current === task) {
        current = null;
    }
    if (emit) {
        task.send({
            type: "result",
            taskId: task.taskId,
            assignmentId: task.assignmentId,
            exitCode,
            cancelled: task.wasCancelled,
            error: task.wasCancelled ? undefined : error,
        });
    }
    return true;
}

export function startTask({ taskId, assignmentId, inputPath, executable, args }, send) {
    if (current) {
        logging.warn("runner", `received assign for ${taskId} while busy with ${current.taskId} — ignoring`);
        return false;
    }

    const task = {
        taskId,
        assignmentId,
        send,
        proc: null,
        wasCancelled: false,
        stderrTail: "",
        settled: false,
        killTimer: null,
        onClose: null,
        onError: null,
        onStderr: null,
    };
    current = task;

    // Verify the source is actually reachable on this runner before spawning. A missing input here
    // almost always means the shared /data mount is absent or mapped to a different path.
    if (inputPath && !existsSync(inputPath)) {
        finish(task, { error: `input file not found on runner: ${inputPath}` });
        return true;
    }

    try {
        // stdin set to "ignore": ffmpeg must never block waiting on an interactive prompt. cwd is
        // pinned to tmp so relative side writes from an allowlisted flag do not land in the app.
        task.proc = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], cwd: os.tmpdir() });
    } catch (error) {
        finish(task, { error: error.message });
        return true;
    }

    task.onStderr = (chunk) => {
        const text = chunk.toString();
        const progressMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (progressMatch && !task.settled) {
            send({ type: "progress", taskId, assignmentId, time: progressMatch[1] });
        }
        task.stderrTail = (task.stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    };
    task.onClose = (exitCode) => {
        const error = !task.wasCancelled && exitCode !== 0 ? ffmpegErrorTail(task.stderrTail) : undefined;
        finish(task, { exitCode, error });
    };
    task.onError = (error) => finish(task, { error: error.message });

    task.proc.stderr.on("data", task.onStderr);
    task.proc.once("close", task.onClose);
    task.proc.once("error", task.onError);
    return true;
}

export function cancelTask(taskId) {
    const task = current;
    if (!task || task.taskId !== taskId || task.settled) {
        return false;
    }
    task.wasCancelled = true;
    try {
        task.proc.kill("SIGTERM");
    } catch {}
    task.killTimer = setTimeout(() => {
        if (task.settled) {
            return;
        }
        try {
            task.proc.kill("SIGKILL");
        } catch {}
    }, SIGKILL_GRACE_MS);
    task.killTimer.unref?.();
    return true;
}

// Kill any in-flight ffmpeg without reporting a result — used when the socket drops. Listener
// detachment happens before the kill, so its later error/close callbacks cannot settle or clear a
// newer assignment.
export function abortCurrent() {
    const task = current;
    if (!task) {
        return false;
    }
    finish(task, { emit: false });
    try {
        task.proc?.kill("SIGKILL");
    } catch {}
    return true;
}
