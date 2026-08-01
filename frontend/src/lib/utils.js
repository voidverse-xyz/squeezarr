import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
    return twMerge(clsx(inputs));
}

// Unwrap a response envelope (see shared/response.js) for the UI: fall back to a default when
// the call failed or carried no data. Hooks initialize state to an empty/falsy default and
// pipe every result through this, so "loading" is just "still the default" — no separate
// loading/error flags.
export function getDataFromResult(result, defaultData) {
    return !result?.success || result.data == null ? defaultData : result.data;
}

export function formatBytes(bytes) {
    if (bytes == null) {
        return "—";
    }
    if (bytes === 0) {
        return "0 B";
    }
    if (bytes < 1024 ** 2) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    if (bytes < 1024 ** 3) {
        return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    }
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(startTimestamp) {
    if (!startTimestamp) {
        return "—";
    }
    const totalSeconds = Math.floor((Date.now() - startTimestamp) / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    if (totalSeconds < 3600) {
        return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
    }
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

export function formatDateTime(timestamp) {
    if (!timestamp) {
        return "—";
    }
    const ms = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ffmpeg progress timecode ("HH:MM:SS.mmm") → seconds, or null if it can't be parsed.
export function parseTimecode(tc) {
    if (!tc) {
        return null;
    }
    const m = /(\d+):(\d+):(\d+)(?:\.(\d+))?/.exec(tc);
    if (!m) {
        return null;
    }
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

// Transcode render progress as { pct, label }: a percentage once the media duration is known,
// otherwise the raw elapsed timecode (pct null). Null when no progress has been reported yet.
export function transcodeProgress(progressTimecode, durationSeconds) {
    const elapsed = parseTimecode(progressTimecode);
    if (elapsed == null) {
        return null;
    }
    if (durationSeconds > 0) {
        const pct = Math.min(100, Math.round((elapsed / durationSeconds) * 100));
        return { pct, label: `${pct}%` };
    }
    return { pct: null, label: progressTimecode };
}

export function formatAge(timestamp) {
    if (!timestamp) {
        return "—";
    }
    const ms = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
    const elapsedSeconds = Math.floor((Date.now() - ms) / 1000);
    if (elapsedSeconds < 60) {
        return `${elapsedSeconds}s ago`;
    }
    if (elapsedSeconds < 3600) {
        return `${Math.floor(elapsedSeconds / 60)}m ago`;
    }
    if (elapsedSeconds < 86400) {
        return `${Math.floor(elapsedSeconds / 3600)}h ago`;
    }
    return `${Math.floor(elapsedSeconds / 86400)}d ago`;
}
