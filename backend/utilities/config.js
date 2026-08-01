// Server runtime config sourced from the environment (set per-container in compose.yaml), NOT from
// the user-editable settings. These drive process execution and the filesystem, so they must not be
// settable through the API: the ffmpeg/ffprobe binaries and the directory we scan.
export const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
export const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
export const dataDir = process.env.DATA_DIR || "/data";

// The allowlist of ffmpeg flag options a transcode setting may use. The server owns the binary, the
// input, and the output (it builds `ffmpeg -y -i <input> <flags> <output>`); the user only supplies
// <flags>, and only flags on this list are accepted. Everything that can read/write arbitrary files
// or reach the network is deliberately absent — `-i` (extra inputs), filters (`-vf`/`-filter_complex`
// /…, which can read files), `-f` (formats/protocols) — so the only files ffmpeg ever touches are the
// input and output we control. Stream specifiers match on the base option (`-c:v` -> `-c`).
//
// Ships with sensible defaults; an operator can ADD to it (never replace) via FFMPEG_EXTRA_FLAGS
// (space/comma separated) without exposing the whole command — e.g. FFMPEG_EXTRA_FLAGS="-vf -af".
const DEFAULT_ALLOWED_FLAGS = [
    "-map",
    "-c",
    "-crf",
    "-qp",
    "-preset",
    "-b",
    "-q",
    "-pix_fmt",
    "-profile",
    "-level",
    "-tune",
    "-g",
    "-r",
    "-threads",
    "-ac",
    "-ar",
    "-channel_layout",
    "-movflags",
    "-vsync",
    "-fps_mode",
    "-shortest",
    "-x265-params",
    "-x264-params",
    "-svtav1-params",
    "-aom-params",
    "-vp9-params",
];

const extra = (process.env.FFMPEG_EXTRA_FLAGS || "").split(/[\s,]+/).filter(Boolean);

export const ALLOWED_FLAGS = new Set([...DEFAULT_ALLOWED_FLAGS, ...extra]);
