import { createValueGeneration } from "./operation-fence.js";

export const EMPTY_DASHBOARD_FILES = Object.freeze({ items: [], total: 0, stats: {} });

export function cancelDashboardBatchForGeneration(inFlight, filterGeneration, cancel) {
    if (inFlight?.filterGeneration !== filterGeneration) return false;
    cancel();
    return true;
}

export async function runDashboardUpdateEntry(
    { filterController, filterGeneration, lifecycleRef, latestRef, inFlightRef, startBatch },
    { force = false, afterCurrent = false } = {},
) {
    // Render advances the controller before passive cleanup runs. Reject an entry captured by
    // the obsolete render before it can observe or mutate the shared in-flight request state.
    if (!lifecycleRef.current.isMounted() || !filterController.isCurrent(filterGeneration)) return false;
    // A callback for the latest rendered filter must never join the previous filter's batch,
    // even in the render-to-effect handoff. Ordinary same-filter refreshes do join, while a
    // forced same-filter refresh supersedes its older poll.
    if (inFlightRef.current?.filterGeneration !== filterGeneration) {
        latestRef.current.cancel();
        inFlightRef.current = null;
    }
    if (afterCurrent && inFlightRef.current) {
        const joined = inFlightRef.current;
        await joined.promise;
        if (!lifecycleRef.current.isMounted() || !filterController.isCurrent(filterGeneration)) {
            return false;
        }
        if (inFlightRef.current === joined) inFlightRef.current = null;
    }
    if (force && inFlightRef.current) {
        latestRef.current.cancel();
        inFlightRef.current = null;
    }
    if (inFlightRef.current) return inFlightRef.current.promise;
    const lifecycle = lifecycleRef.current.start("batch");
    const request = latestRef.current.start();
    const pending = startBatch({ lifecycle, request });
    const inFlight = { filterGeneration, promise: pending };
    inFlightRef.current = inFlight;
    pending.finally(() => {
        if (inFlightRef.current === inFlight) inFlightRef.current = null;
    });
    return pending;
}

export function createInitialDashboardDataState() {
    return {
        filesData: EMPTY_DASHBOARD_FILES,
        jobs: [],
        processingPaused: false,
        statsData: null,
        workers: [],
        loading: true,
        error: null,
        stale: false,
        settledFilterGeneration: null,
        snapshotFilterGeneration: null,
    };
}

// Owns the render-time filter generation used by the dashboard hook. Publications are reduced
// through this controller so a batch that settles during the render-to-effect handoff cannot write
// state for the filter that is no longer rendered.
export function createDashboardDataController(initialFilter) {
    const filters = createValueGeneration(initialFilter);

    return {
        render(filter) {
            return filters.update(filter);
        },
        current() {
            return filters.current();
        },
        isCurrent(filterGeneration) {
            return filters.isCurrent(filterGeneration);
        },
        publishSuccess(state, filterGeneration, snapshot) {
            if (!filters.isCurrent(filterGeneration)) return state;
            return {
                ...snapshot,
                loading: false,
                error: null,
                stale: false,
                settledFilterGeneration: filterGeneration,
                snapshotFilterGeneration: filterGeneration,
            };
        },
        publishError(state, filterGeneration, error) {
            if (!filters.isCurrent(filterGeneration)) return state;
            const hasCurrentSnapshot = state.snapshotFilterGeneration === filterGeneration;
            return {
                ...state,
                loading: false,
                error,
                stale: hasCurrentSnapshot,
                settledFilterGeneration: filterGeneration,
            };
        },
        project(state, filterGeneration) {
            const hasCurrentSettlement = state.settledFilterGeneration === filterGeneration;
            const hasCurrentSnapshot = state.snapshotFilterGeneration === filterGeneration;
            return {
                filesData: hasCurrentSnapshot ? state.filesData : EMPTY_DASHBOARD_FILES,
                jobs: hasCurrentSnapshot ? state.jobs : [],
                processingPaused: hasCurrentSnapshot ? state.processingPaused : false,
                statsData: hasCurrentSnapshot ? state.statsData : null,
                workers: hasCurrentSnapshot ? state.workers : [],
                loading: !hasCurrentSettlement || state.loading,
                error: hasCurrentSettlement ? state.error : null,
                stale: hasCurrentSettlement && hasCurrentSnapshot && state.stale,
                actionsReady: hasCurrentSnapshot,
            };
        },
    };
}
