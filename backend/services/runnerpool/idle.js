// The pool nudges the event loop whenever runner capacity changes (a runner connects, frees up, or
// is unpaused) so dispatch re-runs immediately instead of waiting out the idle timeout. The
// listener is wired by event.initialize() to avoid a runnerpool↔event import cycle; holding it in
// its own module lets every part of the pool fire it without importing the barrel.
let idleListener = () => {};

export function setIdleListener(listener) {
    idleListener = listener;
}

export function notifyIdle() {
    idleListener();
}
