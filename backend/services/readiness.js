// Monitor readiness is kept separate from runner-only lifecycle. Runner-only processes do not
// expose HTTP and never initialize this state; the monitor updates each required subsystem as it
// starts and stops, and /api/health reports the aggregate snapshot.
const SUBSYSTEMS = ["mongod", "database", "queue", "http", "processing"];

const state = Object.fromEntries(SUBSYSTEMS.map((name) => [name, "stopped"]));
let processingCapacity = {
    connected: 0,
    idle: 0,
    busy: 0,
    paused: 0,
    accepting: 0,
};

export function setSubsystem(name, ready, unavailableStatus = "unavailable") {
    if (!SUBSYSTEMS.includes(name)) {
        throw new Error(`Unknown readiness subsystem: ${name}`);
    }
    state[name] = ready ? "ready" : unavailableStatus;
}

export function setProcessingCapacity(capacity) {
    processingCapacity = { ...capacity };
    setSubsystem("processing", processingCapacity.connected > 0, "no_runners");
}

export function stopProcessing() {
    processingCapacity = {
        connected: 0,
        idle: 0,
        busy: 0,
        paused: 0,
        accepting: 0,
    };
    setSubsystem("processing", false, "stopped");
}

export function getReadiness() {
    const subsystems = { ...state };
    const ready = SUBSYSTEMS.every((name) => subsystems[name] === "ready");
    return {
        ready,
        status: ready ? "ready" : "not_ready",
        subsystems,
        capacity: { processing: { ...processingCapacity } },
    };
}

// Primarily useful for startup and isolated tests. It deliberately does not run in runner-only
// mode, whose health is the runner connection/restart policy rather than an HTTP endpoint.
export function reset() {
    for (const name of SUBSYSTEMS) {
        state[name] = "stopped";
    }
    processingCapacity = {
        connected: 0,
        idle: 0,
        busy: 0,
        paused: 0,
        accepting: 0,
    };
}
