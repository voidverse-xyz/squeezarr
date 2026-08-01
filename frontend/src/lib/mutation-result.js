import { API_ERROR_KIND } from "../api/client.js";

const AMBIGUOUS_MUTATION_KINDS = new Set([API_ERROR_KIND.timeout, API_ERROR_KIND.transport, API_ERROR_KIND.parse]);

export function isAmbiguousMutationResult(result) {
    return !result?.success && AMBIGUOUS_MUTATION_KINDS.has(result?.error?.kind);
}

// Dispatch exactly once. If its outcome is ambiguous, optionally read authoritative state, but
// never replay the mutation. Callers decide what explicit operator action is safe after this.
export async function settleMutation({ mutate, reconcile }) {
    const result = await mutate();
    const ambiguous = isAmbiguousMutationResult(result);
    const authoritativeResult = ambiguous && reconcile ? await reconcile() : null;
    return {
        result,
        ambiguous,
        authoritativeResult,
        reconciled: authoritativeResult?.success === true,
    };
}
