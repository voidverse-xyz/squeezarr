"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Header from "@/components/header";
import AuthGate from "@/components/authgate";
import ConfirmDialog from "@/components/confirmdialog";
import StatCards from "@/components/dashboard/statcards";
import FilesTab from "@/components/dashboard/filestab";
import JobsTab from "@/components/dashboard/jobstab";
import StatisticsTab from "@/components/dashboard/statisticstab";
import WorkersTab from "@/components/dashboard/workerstab";
import { useDashboardData } from "@/hooks/dashboard";
import { filesApi, actionsApi, runnersApi } from "@/api";
import { coordinateDashboardMutation, createLatestCoordinator } from "@/lib/dashboard-mutation";
import { createMutationGate } from "@/lib/mutation-gate";
import { createOperationFence, createValueGeneration } from "@/lib/operation-fence";
import { dashboardViewState } from "@/lib/operational-view";
import { TABS, CONFIRM_DANGER } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useI18n } from "@/context/i18n";

function Dashboard() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { t } = useI18n();

    const tabParam = searchParams.get("tab");
    const tab = TABS.includes(tabParam) ? tabParam : "files";
    const statusFilter = searchParams.get("filter") ?? "all";

    const {
        filesData,
        jobs,
        processingPaused,
        statsData,
        workers,
        loading,
        error,
        stale,
        actionsReady,
        update,
        setProcessing,
    } = useDashboardData(statusFilter);

    // View state lives in the page; the data lives in the hook (see hooks/dashboard.js).
    const [expandedFiles, setExpandedFiles] = useState(() => new Set());
    const [expandedJobs, setExpandedJobs] = useState(() => new Set());
    const [busy, setBusy] = useState({});
    const [confirm, setConfirm] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [pauseBlocked, setPauseBlocked] = useState(false);
    const [scanBlocked, setScanBlocked] = useState(false);
    const actionFenceRef = useRef(createOperationFence());
    const pauseGateRef = useRef(createMutationGate());
    const scanGateRef = useRef(createMutationGate());
    const [latestUpdate] = useState(() => createLatestCoordinator(update));
    latestUpdate.update(update);
    const [filterLifecycle] = useState(() => createValueGeneration(statusFilter));
    const currentFilterGeneration = filterLifecycle.update(statusFilter);
    const currentActionError =
        actionError?.replayBlocked || actionError?.filterGeneration === currentFilterGeneration ? actionError : null;
    const currentBusy = busy.__filterGeneration === currentFilterGeneration ? busy : {};
    const currentConfirm = actionsReady && confirm?.filterGeneration === currentFilterGeneration ? confirm : null;

    useEffect(() => {
        const fence = actionFenceRef.current;
        fence.mount();
        return () => fence.unmount();
    }, []);

    function navigate(newTab, newFilter) {
        const params = new URLSearchParams();
        // Always include the tab param (even the default "files"). Navigating to a bare path
        // with no query string does not re-trigger useSearchParams(), so switching back to the
        // files tab from another tab would leave the view stuck.
        const tabKey = TABS.includes(newTab) ? newTab : "files";
        params.set("tab", tabKey);
        if (newFilter && newFilter !== "all") {
            params.set("filter", newFilter);
        }
        router.replace(`/dashboard?${params.toString()}`);
    }

    function actionType(key) {
        if (key === "scan") return "scan";
        if (key === "processing") return "processing";
        if (key.startsWith("pause-")) return "workerPause";
        if (key.startsWith("del-out-")) return "deleteOutput";
        if (key.startsWith("del-")) return "delete";
        if (key.startsWith("replace-")) return "replace";
        if (key.startsWith("stop-")) return "stop";
        if (key.startsWith("requeue-")) return "requeue";
        return "default";
    }

    async function reconcilePauseGate() {
        const reconciliation = await pauseGateRef.current.reconcile(async () => ({
            success: await latestUpdate.run({ afterCurrent: true }),
        }));
        if (actionFenceRef.current.isMounted() && reconciliation.cleared) {
            setPauseBlocked(false);
            setActionError(null);
        }
        return reconciliation.cleared;
    }

    // Run a backend action once. Transport, timeout, and parse failures remain safety-relevant even
    // if navigation made their filter-specific UI ticket obsolete. Reconciliation always joins or
    // starts the latest filter's coordinator; it never calls an update closed over from the old one.
    async function act(key, fn) {
        const type = actionType(key);
        if (type === "processing" && pauseGateRef.current.isBlocked()) return reconcilePauseGate();
        if (type === "scan" && scanGateRef.current.isBlocked()) return false;

        const operation = actionFenceRef.current.start(key);
        // Capture the generation represented by this render. An event from filter A's committed
        // controls must fail closed if filter B has begun rendering.
        const filterGeneration = currentFilterGeneration;
        const canPublish = () => operation.isCurrent() && filterLifecycle.isCurrent(filterGeneration);
        if (!canPublish()) return false;
        setBusy((b) => ({
            ...(b.__filterGeneration === filterGeneration ? b : {}),
            __filterGeneration: filterGeneration,
            [key]: true,
        }));
        const requiresRefresh =
            currentActionError?.key === key &&
            currentActionError.ambiguous === true &&
            currentActionError.refreshed !== true;
        if (!requiresRefresh) setActionError(null);
        try {
            if (requiresRefresh) {
                const recovered =
                    type === "processing" ? await reconcilePauseGate() : await latestUpdate.run({ afterCurrent: true });
                if (canPublish() && recovered) setActionError(null);
                return false;
            }
            // Never cancel a dispatched mutation on navigation/unmount. Obsolete publication is
            // suppressed separately from the ambiguity gates installed below.
            const outcome = await coordinateDashboardMutation({
                mutate: fn,
                reconcile: type === "processing" ? reconcilePauseGate : () => latestUpdate.run({ afterCurrent: true }),
                canPublish,
                reconcileAmbiguous: type !== "scan",
                onAmbiguous: () => {
                    if (!actionFenceRef.current.isMounted()) return;
                    if (type === "processing") {
                        pauseGateRef.current.block();
                        setPauseBlocked(true);
                    } else if (type === "scan") {
                        scanGateRef.current.block();
                        setScanBlocked(true);
                    }
                },
            });
            if (outcome.obsolete) return false;
            const { result, ambiguous, refreshed } = outcome;
            if (!result?.success) {
                setActionError({
                    key,
                    type,
                    filterGeneration,
                    replayBlocked: ambiguous && type === "scan",
                    result,
                    ambiguous,
                    refreshed,
                    retry: ambiguous
                        ? async () => {
                              // Ambiguous outcomes are never replayed. Processing must clear its
                              // gate through an authoritative refresh; other actions refresh only.
                              const recovered =
                                  type === "processing"
                                      ? await reconcilePauseGate()
                                      : await latestUpdate.run({ afterCurrent: true });
                              if (actionFenceRef.current.isMounted() && recovered) setActionError(null);
                              return recovered;
                          }
                        : () => act(key, fn),
                });
                return false;
            }
            return refreshed && canPublish();
        } finally {
            if (canPublish()) setBusy((b) => ({ ...b, [key]: false }));
        }
    }

    function toggleExpanded(setFn, id) {
        setFn((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }

    const stats = filesData.stats || {};
    const confirmDanger = CONFIRM_DANGER[currentConfirm?.type] ?? false;
    const confirmLabel = t.actions[currentConfirm?.type] ?? t.actions.confirm;
    const viewState = dashboardViewState({ loading, error, stale });
    const showSnapshot = viewState === "ready" || viewState === "stale";

    return (
        <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
            <Header
                onTitleClick={() => navigate("files")}
                processingPaused={processingPaused}
                processingBusy={currentBusy.processing || pauseBlocked || !actionsReady}
                onToggleProcessing={() => act("processing", () => setProcessing(!processingPaused))}
                onScan={() => act("scan", () => actionsApi.scan())}
                scanning={currentBusy.scan}
                scanDisabled={scanBlocked || !actionsReady}
                navButton={
                    <Button variant="outline" size="sm" title={t.nav.settings} onClick={() => router.push("/settings")}>
                        <Settings size={14} />
                    </Button>
                }
            />

            {viewState === "loading" && (
                <Card className="p-4 text-sm text-muted-foreground">{t.dashboard.loading}</Card>
            )}

            {viewState === "initial-error" && (
                <Card className="p-4 space-y-3 text-sm text-red-400">
                    <p>{t.dashboard.loadError}</p>
                    <Button size="sm" variant="outline" onClick={() => update({ force: true })}>
                        {t.actions.retry}
                    </Button>
                </Card>
            )}

            {viewState === "stale" && (
                <Card className="p-3 flex items-center justify-between gap-3 text-sm text-amber-400">
                    <span>{t.dashboard.staleWarning}</span>
                    <Button size="sm" variant="outline" onClick={() => update({ force: true })}>
                        {t.actions.retry}
                    </Button>
                </Card>
            )}

            {pauseBlocked && currentActionError?.key !== "processing" && (
                <Card className="p-3 flex items-center justify-between gap-3 text-sm text-red-400">
                    <span>{t.dashboard.pauseReconciliationRequired}</span>
                    <Button size="sm" variant="outline" onClick={reconcilePauseGate}>
                        {t.actions.refresh}
                    </Button>
                </Card>
            )}

            {scanBlocked && !currentActionError?.replayBlocked && (
                <Card className="p-3 text-sm text-red-400">{t.dashboard.ambiguousScanBlocked}</Card>
            )}

            {currentActionError && (
                <Card className="p-3 flex items-center justify-between gap-3 text-sm text-red-400">
                    <span>
                        {t.dashboard.actionErrors[currentActionError.type] || t.dashboard.actionErrors.default}
                        {currentActionError.ambiguous
                            ? ` ${
                                  currentActionError.replayBlocked
                                      ? t.dashboard.ambiguousScanBlocked
                                      : currentActionError.refreshed
                                        ? t.dashboard.ambiguousAction
                                        : t.dashboard.ambiguousActionRefreshFailed
                              }`
                            : ""}
                    </span>
                    {!currentActionError.replayBlocked && (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={currentBusy[currentActionError.key]}
                            onClick={currentActionError.retry}
                        >
                            {currentActionError.ambiguous ? t.actions.refresh : t.actions.retry}
                        </Button>
                    )}
                </Card>
            )}

            {showSnapshot && <StatCards stats={stats} statsData={statsData} workers={workers} onNavigate={navigate} />}

            {showSnapshot && (
                <div className="flex gap-1 border-b border-border">
                    {TABS.map((tabName) => (
                        <button
                            key={tabName}
                            onClick={() => navigate(tabName)}
                            className={cn(
                                "px-3 py-1.5 text-sm -mb-px border-b-2 transition-colors",
                                tabName === tab
                                    ? "border-primary text-foreground"
                                    : "border-transparent text-muted-foreground hover:text-foreground",
                            )}
                        >
                            {t.tabs[tabName]}
                        </button>
                    ))}
                </div>
            )}

            {showSnapshot && tab === "files" && (
                <FilesTab
                    filesData={filesData}
                    statusFilter={statusFilter}
                    expandedFiles={expandedFiles}
                    onToggleExpand={(id) => toggleExpanded(setExpandedFiles, id)}
                    busy={currentBusy}
                    act={act}
                    setConfirm={(nextConfirm) =>
                        setConfirm(nextConfirm ? { ...nextConfirm, filterGeneration: currentFilterGeneration } : null)
                    }
                    onNavigate={navigate}
                    workers={workers}
                />
            )}

            {showSnapshot && tab === "jobs" && (
                <JobsTab
                    jobs={jobs}
                    expandedJobs={expandedJobs}
                    onToggleExpand={(id) => toggleExpanded(setExpandedJobs, id)}
                />
            )}

            {showSnapshot && tab === "stats" && <StatisticsTab statsData={statsData} />}

            {showSnapshot && tab === "workers" && (
                <WorkersTab
                    workers={workers}
                    busy={currentBusy}
                    onTogglePause={(runnerId, paused) =>
                        act(`pause-${runnerId}`, () => runnersApi.setPaused(runnerId, paused))
                    }
                />
            )}

            <ConfirmDialog
                open={!!currentConfirm}
                title={currentConfirm?.title || ""}
                message={currentConfirm?.message || ""}
                confirmLabel={confirmLabel}
                danger={confirmDanger}
                onConfirm={() => {
                    if (!currentConfirm) {
                        return;
                    }
                    if (currentConfirm.type === "delete") {
                        act(`del-${currentConfirm.fileId}`, () => filesApi.remove(currentConfirm.fileId));
                    } else if (currentConfirm.type === "replace") {
                        act(`replace-${currentConfirm.fileId}-${currentConfirm.settingId}`, () =>
                            filesApi.replace(currentConfirm.fileId, currentConfirm.settingId),
                        );
                    } else if (currentConfirm.type === "deleteOutput") {
                        act(`del-out-${currentConfirm.fileId}-${currentConfirm.settingId}`, () =>
                            filesApi.deleteOutput(currentConfirm.fileId, currentConfirm.settingId),
                        );
                    } else {
                        act(`stop-${currentConfirm.fileId}`, () => filesApi.stop(currentConfirm.fileId));
                    }
                }}
                onClose={() => setConfirm(null)}
            />
        </div>
    );
}

export default function Page() {
    return (
        <AuthGate>
            <Suspense>
                <Dashboard />
            </Suspense>
        </AuthGate>
    );
}
