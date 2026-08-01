// Persistent fail-closed gate for an ambiguous mutation whose authoritative reconciliation failed.
// The gate never dispatches a mutation. It clears only after its owner supplies a successful,
// authoritative lifecycle read (or when the owning hook is remounted and creates a new gate).
export function createMutationGate() {
    let blocked = false;
    return {
        block() {
            blocked = true;
        },
        isBlocked() {
            return blocked;
        },
        async reconcile(read) {
            if (!blocked) return { cleared: true, result: null };
            const result = await read();
            if (result?.success) blocked = false;
            return { cleared: !blocked, result };
        },
    };
}
