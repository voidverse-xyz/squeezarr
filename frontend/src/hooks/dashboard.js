"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { filesApi, jobsApi, statsApi, actionsApi, runnersApi } from "@/api";
import { createLatestRequest } from "@/lib/latest-request";
import {
    cancelDashboardBatchForGeneration,
    createDashboardDataController,
    createInitialDashboardDataState,
    runDashboardUpdateEntry,
} from "@/lib/dashboard-data-controller";
import { createOperationFence } from "@/lib/operation-fence";
import { getDataFromResult } from "@/lib/utils";
import { POLL_INTERVAL, DEFAULT_PAGE_SIZE, JOBS_FETCH_LIMIT } from "@/lib/constants";

export function useDashboardData(statusFilter) {
    const [dataState, setDataState] = useState(createInitialDashboardDataState);
    const latestRef = useRef(createLatestRequest());
    const inFlightRef = useRef(null);
    const lifecycleRef = useRef(createOperationFence());
    const [filterController] = useState(() => createDashboardDataController(statusFilter));
    const filterGeneration = filterController.render(statusFilter);

    const update = useCallback(
        (requestOptions) =>
            runDashboardUpdateEntry(
                {
                    filterController,
                    filterGeneration,
                    lifecycleRef,
                    latestRef,
                    inFlightRef,
                    startBatch: ({ lifecycle, request }) => {
                        const options = { signal: request.signal };
                        return (async () => {
                            const results = await Promise.all([
                                filesApi.list({ status: statusFilter, limit: DEFAULT_PAGE_SIZE }, options),
                                jobsApi.list({ limit: JOBS_FETCH_LIMIT }, options),
                                actionsApi.getProcessing(options),
                                statsApi.get(options),
                                runnersApi.list(options),
                            ]);
                            if (
                                !lifecycle.isCurrent() ||
                                !request.isLatest() ||
                                !filterController.isCurrent(filterGeneration)
                            ) {
                                return false;
                            }
                            const failed = results.find((result) => !result?.success);
                            if (failed) {
                                setDataState((state) => filterController.publishError(state, filterGeneration, failed));
                                return false;
                            }
                            const [filesRes, jobsRes, processingRes, statsRes, workersRes] = results;
                            const snapshot = {
                                filesData: getDataFromResult(filesRes, { items: [], total: 0, stats: {} }),
                                jobs: getDataFromResult(jobsRes, { items: [] }).items || [],
                                processingPaused: getDataFromResult(processingRes, { paused: false }).paused === true,
                                statsData: getDataFromResult(statsRes, null),
                                workers: getDataFromResult(workersRes, { runners: [] }).runners || [],
                            };
                            setDataState((state) => filterController.publishSuccess(state, filterGeneration, snapshot));
                            return true;
                        })().catch((failure) => {
                            if (
                                !lifecycle.isCurrent() ||
                                !request.isLatest() ||
                                !filterController.isCurrent(filterGeneration)
                            ) {
                                return false;
                            }
                            setDataState((state) =>
                                filterController.publishError(state, filterGeneration, {
                                    output: failure.message || "request_failed",
                                }),
                            );
                            return false;
                        });
                    },
                },
                requestOptions,
            ),
        [filterController, filterGeneration, statusFilter],
    );

    useEffect(() => {
        const latest = latestRef.current;
        const lifecycle = lifecycleRef.current;
        lifecycle.mount();
        return () => {
            lifecycle.unmount();
            latest.cancel();
            inFlightRef.current = null;
        };
    }, []);

    useEffect(() => {
        const latest = latestRef.current;
        let cancelled = false;
        let timer;
        const poll = async () => {
            await update();
            if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL);
        };
        poll();
        return () => {
            cancelled = true;
            clearTimeout(timer);
            // A filter-B update can be started by reconciliation during the render-to-effect
            // handoff. Filter A's cleanup may cancel only A, never that already-valid B batch.
            if (cancelDashboardBatchForGeneration(inFlightRef.current, filterGeneration, () => latest.cancel())) {
                inFlightRef.current = null;
            }
        };
    }, [filterGeneration, update]);

    const setProcessing = useCallback(async (paused) => {
        const lifecycle = lifecycleRef.current.start("processing-mutation");
        // Do not attach the read-batch signal: once dispatched, this mutation is allowed to settle.
        const result = await actionsApi.setProcessing(paused);
        if (lifecycle.isCurrent() && result?.success) {
            setDataState((state) => ({
                ...state,
                processingPaused: getDataFromResult(result, { paused }).paused === true,
            }));
        }
        return result;
    }, []);

    return {
        ...filterController.project(dataState, filterGeneration),
        update,
        setProcessing,
    };
}
