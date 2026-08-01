// Coordinates replaceable reads without coupling them to React. Starting a generation aborts the
// previous request; the generation check remains necessary for request functions that settle after
// ignoring cancellation.
export function createLatestRequest() {
    let generation = 0;
    let controller = null;

    return {
        start() {
            controller?.abort();
            controller = new AbortController();
            const currentController = controller;
            const current = ++generation;
            return {
                generation: current,
                signal: currentController.signal,
                isLatest: () => generation === current && !currentController.signal.aborted,
            };
        },
        cancel() {
            generation += 1;
            controller?.abort();
            controller = null;
        },
        isLatest(candidate) {
            return generation === candidate;
        },
    };
}
