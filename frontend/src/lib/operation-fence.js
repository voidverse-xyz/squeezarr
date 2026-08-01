export function createValueGeneration(initialValue) {
    let value = initialValue;
    let generation = 0;
    return {
        update(nextValue) {
            if (!Object.is(value, nextValue)) {
                value = nextValue;
                generation += 1;
            }
            return generation;
        },
        current() {
            return generation;
        },
        isCurrent(candidate) {
            return generation === candidate;
        },
    };
}

// A lifecycle + per-key generation fence for asynchronous UI work. It does not abort dispatched
// mutations; it only prevents their late completion from starting reads or publishing state after
// unmount, and lets a newer same-key operation supersede an older one.
export function createOperationFence() {
    let mounted = false;
    let lifecycle = 0;
    const generations = new Map();

    return {
        mount() {
            lifecycle += 1;
            mounted = true;
        },
        unmount() {
            lifecycle += 1;
            mounted = false;
            generations.clear();
        },
        start(key = "default") {
            const generation = (generations.get(key) || 0) + 1;
            const ticketLifecycle = lifecycle;
            generations.set(key, generation);
            return {
                isCurrent: () => mounted && lifecycle === ticketLifecycle && generations.get(key) === generation,
            };
        },
        isMounted() {
            return mounted;
        },
    };
}
