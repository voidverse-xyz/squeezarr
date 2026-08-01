"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { settingsApi, actionsApi } from "@/api";
import { createLatestRequest } from "@/lib/latest-request";
import { createMutationGate } from "@/lib/mutation-gate";
import { settleMutation } from "@/lib/mutation-result";
import { coordinateSettingsWrite } from "@/lib/settings-write";
import { getDataFromResult } from "@/lib/utils";

const SAVED_TOAST_MS = 2000;

export function useSettings() {
    const [settings, setSettings] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [saveAmbiguous, setSaveAmbiguous] = useState(false);
    const [saveReconciled, setSaveReconciled] = useState(true);
    const [pauseError, setPauseError] = useState(null);
    const [pausing, setPausing] = useState(false);
    const [pauseBlocked, setPauseBlocked] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanError, setScanError] = useState(null);
    const [scanBlocked, setScanBlocked] = useState(false);
    const [processingPaused, setProcessingPaused] = useState(false);
    const latestRef = useRef(null);
    const pausedRef = useRef(false);
    const queueRef = useRef(Promise.resolve());
    const loadRequestRef = useRef(createLatestRequest());
    const saveReconciliationRequiredRef = useRef(false);
    const pauseGateRef = useRef(createMutationGate());
    const scanGateRef = useRef(createMutationGate());

    useEffect(() => {
        latestRef.current = settings;
    }, [settings]);

    useEffect(() => {
        pausedRef.current = processingPaused;
    }, [processingPaused]);

    const applyAuthoritative = useCallback((loaded) => {
        latestRef.current = loaded;
        setSettings(loaded);
        pausedRef.current = loaded?.processingPaused === true;
        setProcessingPaused(pausedRef.current);
    }, []);

    const load = useCallback(async () => {
        const request = loadRequestRef.current.start();
        setLoading(true);
        setLoadError(null);
        const result = await settingsApi.get({ signal: request.signal });
        if (!request.isLatest()) return false;
        if (!result?.success) {
            setLoadError(result);
            setLoading(false);
            return false;
        }
        applyAuthoritative(getDataFromResult(result, null));
        saveReconciliationRequiredRef.current = false;
        setSaveReconciled(true);
        setLoading(false);
        return true;
    }, [applyAuthoritative]);

    useEffect(() => {
        const latestLoad = loadRequestRef.current;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial remote settings hydration
        load();
        return () => latestLoad.cancel();
    }, [load]);

    function enqueue(operation) {
        const pending = queueRef.current.then(operation, operation);
        queueRef.current = pending.catch(() => {});
        return pending;
    }

    // Updater functions are evaluated only when they reach the front of the queue, against the
    // latest committed document. This keeps rapid profile toggles/deletes composable.
    function persist(update) {
        return enqueue(async () => {
            setSaving(true);
            setSaveError(null);
            setSaveAmbiguous(false);
            try {
                if (saveReconciliationRequiredRef.current) {
                    const refreshed = getDataFromResult(await settingsApi.get(), null);
                    if (!refreshed) {
                        setSaveError("request_timeout");
                        setSaveAmbiguous(true);
                        setSaveReconciled(false);
                        return false;
                    }
                    applyAuthoritative(refreshed);
                    saveReconciliationRequiredRef.current = false;
                    setSaveError("request_timeout");
                    setSaveAmbiguous(true);
                    setSaveReconciled(true);
                    // This explicit attempt was used only to restore authoritative state. Require a
                    // second operator action before sending the mutation that was based on stale UI.
                    return false;
                }
                const coordinated = await coordinateSettingsWrite({
                    current: latestRef.current,
                    update,
                    save: (candidate) => settingsApi.save(candidate),
                    read: () => settingsApi.get(),
                });
                const { candidate, settlement } = coordinated;
                const result = settlement.result;
                if (!result?.success) {
                    const authoritative =
                        getDataFromResult(result, null) || getDataFromResult(settlement.authoritativeResult, null);
                    if (settlement.ambiguous) {
                        // The write may have committed before its response was lost or truncated.
                        // Reconcile once and never re-evaluate/replay the functional updater here.
                        saveReconciliationRequiredRef.current = !authoritative;
                        setSaveReconciled(Boolean(authoritative));
                    }
                    if (authoritative) applyAuthoritative(authoritative);
                    setSaveAmbiguous(settlement.ambiguous);
                    setSaveError(result?.output || "save_failed");
                    return false;
                }
                const committed = getDataFromResult(result, candidate);
                saveReconciliationRequiredRef.current = false;
                setSaveReconciled(true);
                applyAuthoritative(committed);
                setSaved(true);
                setTimeout(() => setSaved(false), SAVED_TOAST_MS);
                return true;
            } finally {
                setSaving(false);
            }
        });
    }

    async function scan() {
        // There is no authoritative scan-status read. Once an outcome is ambiguous, fail closed for
        // this mounted lifecycle rather than permitting any replay based on acknowledgment alone.
        if (scanGateRef.current.isBlocked()) return false;
        setScanning(true);
        setScanError(null);
        try {
            const settlement = await settleMutation({ mutate: () => actionsApi.scan() });
            if (!settlement.result?.success) {
                if (settlement.ambiguous) {
                    scanGateRef.current.block();
                    setScanBlocked(true);
                }
                setScanError({ ...settlement.result, ambiguous: settlement.ambiguous });
            }
            return settlement.result?.success === true;
        } finally {
            setScanning(false);
        }
    }

    async function retryProcessingReconciliation() {
        const reconciliation = await pauseGateRef.current.reconcile(() => settingsApi.get());
        const authoritative = getDataFromResult(reconciliation.result, null);
        if (!reconciliation.cleared || !authoritative) return false;
        applyAuthoritative(authoritative);
        setPauseBlocked(false);
        setPauseError(null);
        return true;
    }

    function toggleProcessing() {
        return enqueue(async () => {
            if (pauseGateRef.current.isBlocked()) return retryProcessingReconciliation();
            setPausing(true);
            const previous = pausedRef.current;
            const next = !previous;
            setPauseError(null);
            pausedRef.current = next;
            setProcessingPaused(next);
            try {
                const settlement = await settleMutation({
                    mutate: () => actionsApi.setProcessing(next),
                    reconcile: () => settingsApi.get(),
                });
                const result = settlement.result;
                if (result?.success) {
                    pausedRef.current = getDataFromResult(result, { paused: next }).paused === true;
                    setProcessingPaused(pausedRef.current);
                    return true;
                }
                const authoritative = settlement.ambiguous
                    ? getDataFromResult(settlement.authoritativeResult, null)
                    : getDataFromResult(await settingsApi.get(), null);
                if (authoritative) {
                    applyAuthoritative(authoritative);
                } else {
                    pausedRef.current = previous;
                    setProcessingPaused(previous);
                    if (settlement.ambiguous) {
                        pauseGateRef.current.block();
                        setPauseBlocked(true);
                    }
                }
                setPauseError({ ...result, ambiguous: settlement.ambiguous, reconciled: Boolean(authoritative) });
                return false;
            } finally {
                setPausing(false);
            }
        });
    }

    return {
        settings,
        setSettings,
        loading,
        loadError,
        retry: load,
        persist,
        saving,
        saved,
        saveError,
        saveAmbiguous,
        saveReconciled,
        pauseError,
        pausing,
        pauseBlocked,
        retryProcessingReconciliation,
        scanning,
        scan,
        scanError,
        scanBlocked,
        processingPaused,
        toggleProcessing,
    };
}
