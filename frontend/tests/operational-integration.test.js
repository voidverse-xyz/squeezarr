import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as client from "../src/api/client.js";
import {
    cancelDashboardBatchForGeneration,
    createDashboardDataController,
    createInitialDashboardDataState,
    runDashboardUpdateEntry,
} from "../src/lib/dashboard-data-controller.js";
import { coordinateDashboardMutation, createLatestCoordinator } from "../src/lib/dashboard-mutation.js";
import { createLatestRequest } from "../src/lib/latest-request.js";
import { createMutationGate } from "../src/lib/mutation-gate.js";
import { createOperationFence, createValueGeneration } from "../src/lib/operation-fence.js";
import { authViewState, dashboardViewState, settingsViewState } from "../src/lib/operational-view.js";
import { coordinateSettingsWrite } from "../src/lib/settings-write.js";
import { locales } from "../src/lib/strings.js";

const success = (data) => ({ success: true, output: "ok", data, status: 200 });
const failure = (kind, output = `request_${kind}`) => ({
    success: false,
    output,
    error: { kind, status: kind === "parse" ? 200 : null },
    status: kind === "parse" ? 200 : null,
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test("mounted generation fence blocks the dashboard unmount mutation race without cancelling the mutation", async () => {
    const fence = createOperationFence();
    fence.mount();
    const operation = fence.start("scan");
    const dispatched = deferred();
    let mutationCancelled = false;
    let batchRequests = 0;

    const coordinated = coordinateDashboardMutation({
        mutate: () => dispatched.promise,
        reconcile: async () => {
            batchRequests += 5;
            return true;
        },
        canPublish: operation.isCurrent,
    });
    fence.unmount();
    dispatched.resolve(success());

    assert.deepEqual(await coordinated, {
        obsolete: true,
        result: success(),
        ambiguous: false,
        refreshed: false,
    });
    assert.equal(mutationCancelled, false);
    assert.equal(batchRequests, 0);
});

test("old-filter action settlement cannot cancel or overwrite the active new-filter batch", async () => {
    const actionFence = createOperationFence();
    const filterGeneration = createValueGeneration("A");
    const batches = createLatestRequest();
    actionFence.mount();
    const operation = actionFence.start("delete-file");
    const actionFilterGeneration = filterGeneration.current();
    const actionResult = deferred();
    let oldFilterBatches = 0;
    const coordinated = coordinateDashboardMutation({
        mutate: () => actionResult.promise,
        reconcile: async () => {
            oldFilterBatches += 1;
            batches.start();
            return true;
        },
        canPublish: () => operation.isCurrent() && filterGeneration.isCurrent(actionFilterGeneration),
    });

    filterGeneration.update("B");
    const newFilterBatch = batches.start();
    actionResult.resolve(success());
    const outcome = await coordinated;

    assert.equal(outcome.obsolete, true);
    assert.equal(oldFilterBatches, 0);
    assert.equal(newFilterBatch.signal.aborted, false);
    assert.equal(newFilterBatch.isLatest(), true);
});

for (const kind of ["timeout", "transport", "parse"]) {
    test(`obsolete ambiguous processing ${kind} blocks replay and reconciles only through filter B`, async () => {
        const actionFence = createOperationFence();
        const filterGeneration = createValueGeneration("A");
        const pauseGate = createMutationGate();
        const batches = createLatestRequest();
        let oldFilterBatches = 0;
        const latestCoordinator = createLatestCoordinator(async () => {
            oldFilterBatches += 1;
            batches.start();
            return true;
        });
        const actionResult = deferred();
        const filterBBatch = deferred();
        let filterBRefreshes = 0;
        const pauseMutations = 1;
        let filterBPublished = null;
        let filterBInFlight = filterBBatch.promise.then((result) => {
            filterBInFlight = null;
            filterBPublished = "B";
            return result.success;
        });
        const filterBRequest = batches.start();

        actionFence.mount();
        const operation = actionFence.start("processing");
        const actionFilterGeneration = filterGeneration.current();
        const coordinated = coordinateDashboardMutation({
            mutate: () => actionResult.promise,
            canPublish: () => operation.isCurrent() && filterGeneration.isCurrent(actionFilterGeneration),
            onAmbiguous: () => pauseGate.block(),
            reconcile: async () => {
                const reconciliation = await pauseGate.reconcile(async () => ({
                    success: await latestCoordinator.run({ afterCurrent: true }),
                }));
                return reconciliation.cleared;
            },
        });

        filterGeneration.update("B");
        latestCoordinator.update(async ({ afterCurrent } = {}) => {
            filterBRefreshes += 1;
            assert.equal(afterCurrent, true);
            if (filterBInFlight) await filterBInFlight;
            batches.start();
            if (filterBRefreshes === 1) return false;
            filterBPublished = "B-reconciled";
            return true;
        });
        actionResult.resolve(failure(kind));
        // The safety reconciliation joins B's active batch and must not replace or abort it.
        await Promise.resolve();
        assert.equal(filterBRefreshes, 1);
        assert.equal(filterBRequest.signal.aborted, false);
        filterBBatch.resolve(success({ filter: "B" }));
        const outcome = await coordinated;

        assert.equal(outcome.obsolete, true);
        assert.equal(outcome.ambiguous, true);
        assert.equal(outcome.refreshed, false);
        assert.equal(oldFilterBatches, 0);
        assert.equal(filterBPublished, "B");
        assert.equal(pauseGate.isBlocked(), true);
        assert.equal(pauseMutations, 1);

        // A subsequent processing click is refresh-only while blocked. Only a successful current-B
        // reconciliation clears the gate; it never increments the mutation count.
        const recovery = await pauseGate.reconcile(async () => ({
            success: await latestCoordinator.run({ afterCurrent: true }),
        }));
        assert.equal(recovery.cleared, true);
        assert.equal(pauseGate.isBlocked(), false);
        assert.equal(filterBPublished, "B-reconciled");
        assert.equal(pauseMutations, 1);
    });

    test(`obsolete ambiguous scan ${kind} blocks for the lifecycle without reconciling or replaying`, async () => {
        const actionFence = createOperationFence();
        const filterGeneration = createValueGeneration("A");
        const scanGate = createMutationGate();
        const batches = createLatestRequest();
        let oldFilterBatches = 0;
        const latestCoordinator = createLatestCoordinator(async () => {
            oldFilterBatches += 1;
            batches.start();
            return true;
        });
        const actionResult = deferred();
        const filterBBatch = deferred();
        let filterBRefreshes = 0;
        const scanMutations = 1;
        let filterBPublished = null;
        const filterBRequest = batches.start();

        actionFence.mount();
        const operation = actionFence.start("scan");
        const actionFilterGeneration = filterGeneration.current();
        const coordinated = coordinateDashboardMutation({
            mutate: () => actionResult.promise,
            canPublish: () => operation.isCurrent() && filterGeneration.isCurrent(actionFilterGeneration),
            onAmbiguous: () => scanGate.block(),
            reconcile: () => latestCoordinator.run(),
            reconcileAmbiguous: false,
        });

        filterGeneration.update("B");
        latestCoordinator.update(async () => {
            filterBRefreshes += 1;
            batches.start();
            return true;
        });
        const activeFilterB = filterBBatch.promise.then(() => {
            filterBPublished = "B";
        });
        actionResult.resolve(failure(kind));
        const outcome = await coordinated;

        assert.equal(outcome.obsolete, true);
        assert.equal(outcome.ambiguous, true);
        assert.equal(outcome.refreshed, false);
        assert.equal(oldFilterBatches, 0);
        assert.equal(filterBRefreshes, 0);
        assert.equal(filterBRequest.signal.aborted, false);
        filterBBatch.resolve(success());
        await activeFilterB;
        assert.equal(filterBPublished, "B");
        assert.equal(scanGate.isBlocked(), true);
        assert.equal(scanMutations, 1);
    });
}

test("dashboard ambiguous action reconciles once and never replays the mutation", async () => {
    const fence = createOperationFence();
    fence.mount();
    const operation = fence.start("delete-file");
    let mutations = 0;
    let batches = 0;
    const outcome = await coordinateDashboardMutation({
        mutate: async () => {
            mutations += 1;
            return failure("transport");
        },
        reconcile: async () => {
            batches += 1;
            return true;
        },
        canPublish: operation.isCurrent,
    });

    assert.equal(outcome.ambiguous, true);
    assert.equal(outcome.refreshed, true);
    assert.equal(mutations, 1);
    assert.equal(batches, 1);
});

for (const kind of ["transport", "parse"]) {
    test(`committed settings toggle with ${kind} response loss is reconciled without toggle-back`, async () => {
        const originalFetch = globalThis.fetch;
        let server = { revision: 1, enabled: false };
        let saves = 0;
        let evaluations = 0;
        const update = (current) => {
            evaluations += 1;
            return { ...current, enabled: !current.enabled };
        };
        globalThis.fetch = async (_url, options) => {
            saves += 1;
            const candidate = JSON.parse(options.body);
            server = { ...candidate, revision: candidate.revision + 1 };
            if (kind === "transport") throw new Error("response dropped after commit");
            return new Response('{"success":', { status: 200, statusText: "OK" });
        };

        try {
            const coordinated = await coordinateSettingsWrite({
                current: structuredClone(server),
                update,
                save: (candidate) => client.put("settings", candidate),
                read: async () => success(structuredClone(server)),
            });

            assert.equal(coordinated.settlement.result.error.kind, kind);
            assert.equal(coordinated.settlement.ambiguous, true);
            assert.equal(coordinated.settlement.reconciled, true);
            assert.equal(coordinated.settlement.authoritativeResult.data.enabled, true);
            assert.equal(server.enabled, true);
            assert.equal(saves, 1);
            assert.equal(evaluations, 1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
}

test("failed pause reconciliation and status-less scan remain persistently fail-closed", async () => {
    const pauseGate = createMutationGate();
    const scanGate = createMutationGate();
    const pauseMutations = 1; // The first request committed before its response was dropped.
    const scanMutations = 1;
    pauseGate.block();
    scanGate.block();

    const failedPauseRefresh = await pauseGate.reconcile(async () => failure("transport"));
    assert.equal(failedPauseRefresh.cleared, false);
    assert.equal(pauseGate.isBlocked(), true);
    // Subsequent control clicks are refresh-only while blocked; neither mutation count changes.
    await pauseGate.reconcile(async () => failure("parse"));
    assert.equal(pauseMutations, 1);
    assert.equal(scanGate.isBlocked(), true);
    assert.equal(scanMutations, 1);

    const recoveredPause = await pauseGate.reconcile(async () => success({ processingPaused: true }));
    assert.equal(recoveredPause.cleared, true);
    assert.equal(pauseGate.isBlocked(), false);
    // Scan has no authoritative read and remains blocked for this lifecycle.
    assert.equal(scanGate.isBlocked(), true);
    assert.equal(scanMutations, 1);
});

test("dashboard render-to-effect filter handoff hides A and publishes only B", async () => {
    const controller = createDashboardDataController("A");
    let state = createInitialDashboardDataState();
    const filterA = controller.render("A");
    const batchA = deferred();
    const settlingA = batchA.promise.then((snapshot) => {
        state = controller.publishSuccess(state, filterA, snapshot);
    });

    state = controller.publishSuccess(state, filterA, {
        filesData: { items: [{ fileId: "A-file" }], total: 1, stats: {} },
        jobs: [{ jobId: "A-job" }],
        processingPaused: true,
        statsData: { filter: "A" },
        workers: [{ runnerId: "A-runner" }],
    });
    assert.equal(controller.project(state, filterA).actionsReady, true);

    // The URL has rendered B, but B's passive effect has not started. A's snapshot and every
    // action derived from it must disappear synchronously with this render.
    const filterB = controller.render("B");
    const duringHandoff = controller.project(state, filterB);
    assert.equal(duringHandoff.loading, true);
    assert.deepEqual(duringHandoff.filesData.items, []);
    assert.deepEqual(duringHandoff.jobs, []);
    assert.deepEqual(duringHandoff.workers, []);
    assert.equal(duringHandoff.actionsReady, false);

    batchA.resolve({
        filesData: { items: [{ fileId: "late-A-file" }], total: 1, stats: {} },
        jobs: [],
        processingPaused: false,
        statsData: null,
        workers: [],
    });
    await settlingA;
    assert.equal(controller.project(state, filterB).actionsReady, false);
    assert.equal(state.filesData.items[0].fileId, "A-file");

    state = controller.publishSuccess(state, filterB, {
        filesData: { items: [{ fileId: "B-file" }], total: 1, stats: {} },
        jobs: [{ jobId: "B-job" }],
        processingPaused: false,
        statsData: { filter: "B" },
        workers: [{ runnerId: "B-runner" }],
    });
    const publishedB = controller.project(state, filterB);
    assert.equal(publishedB.loading, false);
    assert.equal(publishedB.actionsReady, true);
    assert.equal(publishedB.filesData.items[0].fileId, "B-file");
});

for (const startFilterBBeforeStaleCallbacks of [true, false]) {
    const timing = startFilterBBeforeStaleCallbacks ? "with B in flight" : "before B starts";
    test(`captured filter A polling and force-Retry entries are rejected ${timing}`, async () => {
        const filterController = createDashboardDataController("A");
        const lifecycleRef = { current: createOperationFence() };
        const latestRef = { current: createLatestRequest() };
        const inFlightRef = { current: null };
        const settlements = { A: deferred(), B: deferred() };
        const starts = { A: 0, B: 0 };
        const requests = {};
        const published = [];
        lifecycleRef.current.mount();

        const createUpdate = (filter, filterGeneration) => (requestOptions) =>
            runDashboardUpdateEntry(
                {
                    filterController,
                    filterGeneration,
                    lifecycleRef,
                    latestRef,
                    inFlightRef,
                    startBatch: ({ lifecycle, request }) => {
                        starts[filter] += 1;
                        requests[filter] = request;
                        return settlements[filter].promise.then(() => {
                            if (
                                !lifecycle.isCurrent() ||
                                !request.isLatest() ||
                                !filterController.isCurrent(filterGeneration)
                            ) {
                                return false;
                            }
                            published.push(filter);
                            return true;
                        });
                    },
                },
                requestOptions,
            );

        const filterA = filterController.render("A");
        const retainedAUpdate = createUpdate("A", filterA);
        const stalePollingCallback = () => retainedAUpdate();
        const staleForceRetryCallback = () => retainedAUpdate({ force: true });

        const filterB = filterController.render("B");
        const updateB = createUpdate("B", filterB);
        let pendingB;
        if (startFilterBBeforeStaleCallbacks) pendingB = updateB();

        assert.equal(await stalePollingCallback(), false);
        assert.equal(await staleForceRetryCallback(), false);
        assert.equal(starts.A, 0);
        if (startFilterBBeforeStaleCallbacks) {
            assert.equal(requests.B.signal.aborted, false);
            assert.equal(inFlightRef.current?.filterGeneration, filterB);
        } else {
            assert.equal(inFlightRef.current, null);
            pendingB = updateB();
        }

        settlements.B.resolve();
        assert.equal(await pendingB, true);
        assert.equal(requests.B.signal.aborted, false);
        assert.deepEqual(starts, { A: 0, B: 1 });
        assert.deepEqual(published, ["B"]);
    });
}

test("filter A cleanup cannot cancel a filter B batch started during the handoff", () => {
    let cancellations = 0;
    const filterA = 0;
    const filterB = 1;
    const activeB = { filterGeneration: filterB };

    assert.equal(
        cancelDashboardBatchForGeneration(activeB, filterA, () => (cancellations += 1)),
        false,
    );
    assert.equal(cancellations, 0);
    assert.equal(
        cancelDashboardBatchForGeneration(activeB, filterB, () => (cancellations += 1)),
        true,
    );
    assert.equal(cancellations, 1);
});

test("dashboard filter errors publish only for their captured current generation", () => {
    const controller = createDashboardDataController("A");
    let state = createInitialDashboardDataState();
    const filterA = controller.render("A");
    const filterB = controller.render("B");

    state = controller.publishError(state, filterA, failure("transport"));
    assert.equal(controller.project(state, filterB).error, null);
    assert.equal(controller.project(state, filterB).loading, true);

    const errorB = failure("parse");
    state = controller.publishError(state, filterB, errorB);
    const projected = controller.project(state, filterB);
    assert.equal(projected.error, errorB);
    assert.equal(projected.loading, false);
    assert.deepEqual(projected.filesData.items, []);
    assert.equal(projected.stale, false);
    assert.equal(projected.actionsReady, false);
});

test("rapid dashboard filter navigation publishes only the newest batch", async () => {
    const latest = createLatestRequest();
    const firstResponse = deferred();
    const secondResponse = deferred();
    const published = [];
    const first = latest.start();
    const firstBatch = firstResponse.promise.then((value) => {
        if (first.isLatest()) published.push(value);
    });
    const second = latest.start();
    const secondBatch = secondResponse.promise.then((value) => {
        if (second.isLatest()) published.push(value);
    });
    secondResponse.resolve("failed-filter");
    await secondBatch;
    firstResponse.resolve("obsolete-all");
    await firstBatch;
    assert.deepEqual(published, ["failed-filter"]);
});

test("mocked envelopes drive dashboard/settings/auth retry and stale recovery states", async () => {
    const sequence = (...results) => {
        let index = 0;
        return async () => results[Math.min(index++, results.length - 1)];
    };

    const dashboardApi = sequence(failure("transport"), success({ items: [] }), failure("parse"));
    let dashboardError = await dashboardApi();
    let hasSnapshot = false;
    assert.equal(dashboardViewState({ loading: false, error: dashboardError, stale: hasSnapshot }), "initial-error");
    const retriedDashboard = await dashboardApi();
    hasSnapshot = retriedDashboard.success;
    dashboardError = null;
    assert.equal(dashboardViewState({ loading: false, error: dashboardError, stale: false }), "ready");
    dashboardError = await dashboardApi();
    assert.equal(dashboardViewState({ loading: false, error: dashboardError, stale: hasSnapshot }), "stale");

    const settingsApi = sequence(failure("transport"), success({ revision: 1 }));
    const failedSettings = await settingsApi();
    assert.equal(settingsViewState({ loading: false, loadError: failedSettings, settings: null }), "error");
    const recoveredSettings = await settingsApi();
    assert.equal(settingsViewState({ loading: false, loadError: null, settings: recoveredSettings.data }), "ready");

    const authApi = sequence(failure("transport"), success({ expiresAt: 1000 }));
    assert.equal((await authApi()).success, false);
    assert.equal(authViewState({ ready: true, authenticated: false, unavailable: true }), "unavailable");
    assert.equal((await authApi()).success, true);
    assert.equal(authViewState({ ready: true, authenticated: true, unavailable: false }), "authenticated");
});

test("operational view transitions cover dashboard, settings, auth recovery, and stale polling", () => {
    assert.equal(dashboardViewState({ loading: true, error: null, stale: false }), "loading");
    assert.equal(dashboardViewState({ loading: false, error: failure("transport"), stale: false }), "initial-error");
    assert.equal(dashboardViewState({ loading: false, error: null, stale: false }), "ready");
    assert.equal(dashboardViewState({ loading: false, error: failure("parse"), stale: true }), "stale");

    assert.equal(settingsViewState({ loading: true, loadError: null, settings: null }), "loading");
    assert.equal(settingsViewState({ loading: false, loadError: failure("transport"), settings: null }), "error");
    assert.equal(settingsViewState({ loading: false, loadError: null, settings: {} }), "ready");

    assert.equal(authViewState({ ready: false, authenticated: false, unavailable: false }), "checking");
    assert.equal(authViewState({ ready: true, authenticated: false, unavailable: true }), "unavailable");
    assert.equal(authViewState({ ready: true, authenticated: true, unavailable: false }), "authenticated");
});

test("rendered operational recovery states contain localized English and Spanish text", () => {
    for (const language of ["en", "es"]) {
        const t = locales[language];
        const markup = renderToStaticMarkup(
            React.createElement(
                "main",
                { lang: language },
                React.createElement("p", { "data-state": "dashboard-error" }, t.dashboard.loadError),
                React.createElement("p", { "data-state": "dashboard-stale" }, t.dashboard.staleWarning),
                React.createElement("p", { "data-state": "action-error" }, t.dashboard.actionErrors.scan),
                React.createElement("p", { "data-state": "settings-error" }, t.settings.loadError),
                React.createElement("p", { "data-state": "auth-unavailable" }, t.auth.unavailable),
                React.createElement("button", null, t.actions.retry),
            ),
        );
        for (const text of [
            t.dashboard.loadError,
            t.dashboard.staleWarning,
            t.dashboard.actionErrors.scan,
            t.settings.loadError,
            t.auth.unavailable,
            t.actions.retry,
        ]) {
            assert.ok(markup.includes(text.replaceAll("'", "&#x27;")) || markup.includes(text));
        }
    }
});
