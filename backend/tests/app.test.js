import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { createRequestTracker } from "../services/shutdown.js";

test("app serves exported pages and applies the shutdown gate before static files and JSON parsing", async (t) => {
    const frontendDir = await mkdtemp(path.join(tmpdir(), "squeezarr-app-"));
    t.after(() => rm(frontendDir, { recursive: true, force: true }));
    await Promise.all([
        writeFile(path.join(frontendDir, "index.html"), "<h1>Home</h1>"),
        writeFile(path.join(frontendDir, "settings.html"), "<h1>Settings</h1>"),
    ]);
    const requestTracker = createRequestTracker();
    const app = createApp({ requestTracker, frontendDir });
    const server = app.listen(0);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const page = await fetch(`${baseUrl}/settings`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>Settings</h1>");

    const fallback = await fetch(`${baseUrl}/client-route`);
    assert.equal(fallback.status, 200);
    assert.equal(await fallback.text(), "<h1>Home</h1>");

    const protectedRoute = await fetch(`${baseUrl}/api/stats`);
    assert.equal(protectedRoute.status, 401);
    assert.equal((await protectedRoute.json()).output, "unauthorized");
    await requestTracker.waitForIdle();

    requestTracker.stopAccepting();
    for (const [route, options] of [
        ["/settings", {}],
        ["/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }],
    ]) {
        const response = await fetch(`${baseUrl}${route}`, options);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("connection"), "close");
        await response.text();
    }
    assert.equal(requestTracker.activeCount(), 0);
});
