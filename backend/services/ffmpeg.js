// The monitor's half of a transcode. The monitor no longer spawns ffmpeg itself — a runner does,
// over a WebSocket (see runner.js / runnerpool.js). This module is split into the two halves of
// that round trip: `prepareTranscode` builds the command and marks the file processing;
// `finalizeTranscode` runs after the runner reports its result and does all the post-transcode
// bookkeeping (filters, rename, results, status). Both the source and the output live on the
// shared /data mount, so the monitor can do the filesystem work after ffmpeg has exited on the
// runner.
export { prepareTranscode } from "./ffmpeg/prepare.js";
export { finalizeTranscode } from "./ffmpeg/finalize.js";
