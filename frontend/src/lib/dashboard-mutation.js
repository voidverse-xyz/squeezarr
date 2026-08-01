import { isAmbiguousMutationResult } from "./mutation-result.js";

// Stable indirection used by long-lived mutation settlements. An action closure may outlive the
// filter that dispatched it, but run() always reaches the newest dashboard update coordinator.
export function createLatestCoordinator(initialCoordinator) {
    let current = initialCoordinator;
    return {
        update(coordinator) {
            current = coordinator;
        },
        run(...args) {
            return current(...args);
        },
    };
}

// Coordinates one already-dispatched dashboard mutation. Publication ownership and ambiguity
// safety are deliberately separate: an obsolete filter must not publish its UI state, but its
// ambiguous result still has to install safety gates and may reconcile through the caller's stable
// latest-dashboard coordinator. The mutation itself is never aborted or replayed here.
export async function coordinateDashboardMutation({
    mutate,
    reconcile,
    canPublish,
    onAmbiguous = () => {},
    reconcileAmbiguous = true,
}) {
    const result = await mutate();
    const ambiguous = isAmbiguousMutationResult(result);
    if (ambiguous) onAmbiguous(result);

    const publishableBeforeRefresh = canPublish();
    const shouldReconcile = (publishableBeforeRefresh && result?.success) || (ambiguous && reconcileAmbiguous);
    const refreshed = shouldReconcile ? await reconcile() : false;

    return { obsolete: !canPublish(), result, ambiguous, refreshed };
}
