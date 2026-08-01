// Runner pool — the monitor's half of the WebSocket. It owns the live registry of connected runners
// and the WS server, dispatches transcodes to idle runners, relays cancellations, and reports
// transcode results back into the pipeline (via ffmpegService.finalizeTranscode, in inbound.js).
// Runners are ephemeral connections, not persisted. The work is split by responsibility under
// runnerpool/: registry (in-memory state), server (WS transport), inbound (messages from runners),
// commands (commands to runners + pause), recovery (requeue lost work), idle (capacity-notify hook).
// This file is the public barrel the rest of the backend imports as `runnerpoolService`.
export { attach, beginShutdown, shutdown, forceShutdown, getShutdownState } from "./runnerpool/server.js";
export { setIdleListener } from "./runnerpool/idle.js";
export { setPaused, assign, relayCancellations } from "./runnerpool/commands.js";
export { list, idleCount as idleRunnerCount } from "./runnerpool/registry.js";
