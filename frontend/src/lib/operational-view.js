export function dashboardViewState({ loading, error, stale }) {
    if (loading) return "loading";
    if (error && !stale) return "initial-error";
    if (stale) return "stale";
    return "ready";
}

export function settingsViewState({ loading, loadError, settings }) {
    if (loading) return "loading";
    if (loadError || !settings) return "error";
    return "ready";
}

export function authViewState({ ready, authenticated, unavailable }) {
    if (!ready) return "checking";
    if (unavailable) return "unavailable";
    return authenticated ? "authenticated" : "anonymous";
}
