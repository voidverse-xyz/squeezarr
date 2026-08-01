// The queue loop's interruptible sleep. When there's nothing to do the loop awaits `waitForWork`;
// `wakeup` cuts that wait short the moment new work is enqueued or a runner frees up. Kept as its
// own module so the single resolver/timer pair has one owner and can't be raced from two places.
const QUEUE_IDLE_WAIT_MS = 5000;

let idleResolver = null;
let idleTimer = null;

// Wake the loop early, cancelling the idle timeout so a stale timer can never clobber a later
// wait's resolver. A no-op when the loop isn't currently waiting.
export function wakeup() {
    if (idleResolver) {
        clearTimeout(idleTimer);
        const resolve = idleResolver;
        idleResolver = null;
        idleTimer = null;
        resolve();
    }
}

// Sleep until work is enqueued (wakeup) or the idle timeout elapses, whichever comes first. The
// timeout is also the upper bound on how long an enqueue can wait before being noticed if a wakeup
// is missed.
export function waitForWork() {
    return new Promise((resolve) => {
        idleResolver = resolve;
        idleTimer = setTimeout(() => {
            idleResolver = null;
            idleTimer = null;
            resolve();
        }, QUEUE_IDLE_WAIT_MS);
    });
}
