import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

test("development HTTP, native count transport and admin API stay synchronized", {
  skip: process.env.RUN_VIEWER_HTTP_TESTS !== "1", timeout: 90_000,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const origin = "http://127.0.0.1:8080";
  const credentials = JSON.parse(await readFile("/tmp/viewer-e2e-credentials.json", "utf8"));
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  assert.equal(login.status, 200, "temporary development admin can log in");
  const auth = await login.json() as { accessToken: string };
  assert.equal(typeof auth.accessToken, "string");
  const require = createRequire(`${process.cwd()}/artifacts/api-server/package.json`);
  globalThis.WebSocket = require("ws");
  const tracking = await import("../../../mobile/lib/viewerTrackingApi.js");
  const { BroadcastEngine } = await import("../../../mobile/vendor/broadcast-sync/src/engine/BroadcastEngine.js");
  const engines = [0, 1].map(() => new BroadcastEngine({
    baseUrl: origin, stateUrl: `${origin}/api/playback/state`,
    wsUrl: "ws://127.0.0.1:8080/api/playback/ws",
  }));
  for (const e of engines) e.start();
  const sessions: Awaited<ReturnType<typeof tracking.issueViewerCredential>>[] = [];
  const renewing = new Set<(typeof sessions)[number]>();
  const timer = setInterval(() => {
    for (const s of renewing) void tracking.sendViewerHeartbeat(origin, s).catch(() => {});
  }, 5000);
  const post = async (path: string, body: unknown) => fetch(`${origin}/api/viewer-tracking/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  async function counts() {
    const [snapshot, admin] = await Promise.all([
      fetch(`${origin}/api/playback/state`).then(r => r.json()) as Promise<{ viewerCount: number | null }>,
      fetch(`${origin}/api/viewer-tracking/stats`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      }).then(async r => { assert.equal(r.status, 200); return r.json(); }) as Promise<{ totalCurrent: number }>,
    ]);
    return [snapshot.viewerCount, admin.totalCurrent, ...engines.map(e => e.getState().viewerCount)];
  }
  async function synchronized(expected: number) {
    const started = Date.now();
    let actual;
    do {
      actual = await counts();
      if (actual.every(n => n === expected)) {
        console.log(JSON.stringify({ expected, counts: actual, convergenceMs: Date.now() - started }));
        return;
      }
      await sleep(100);
    } while (Date.now() - started < 3000);
    assert.deepEqual(actual, [expected, expected, expected, expected], "HTTP, admin API and both native engines converge within 3s");
  }
  try {
    await synchronized(0);
    for (let i = 0; i < 2; i++) {
      const s = await tracking.issueViewerCredential(origin);
      sessions.push(s); renewing.add(s);
      assert.equal((await tracking.sendViewerHeartbeat(origin, s)).status, 200);
    }
    await synchronized(2);
    for (let i = 0; i < 5; i++) { await sleep(500); await synchronized(2); }
    const [a, b] = sessions;
    await tracking.sendViewerHeartbeat(origin, a);
    const resumed = await tracking.issueViewerCredential(origin, undefined, a.sessionId);
    assert.equal(resumed.sessionId, a.sessionId);
    await synchronized(2);

    // Exercise real principal wiring, not just repository deduplication.
    const signedInA = await tracking.issueViewerCredential(origin, auth.accessToken, a.sessionId);
    assert.equal(signedInA.sessionId, a.sessionId, "login preserves installation");
    const anotherDevice = await tracking.issueViewerCredential(origin, auth.accessToken);
    sessions.push(anotherDevice);
    await tracking.sendViewerHeartbeat(origin, anotherDevice);
    await synchronized(2); // signed-in owner + independent guest B
    await tracking.leaveViewerSession(origin, anotherDevice);
    assert.equal((await tracking.issueViewerCredential(origin, undefined, a.sessionId)).sessionId, a.sessionId);
    await synchronized(2); // logout does not create another installation

    renewing.delete(a);
    const old = tracking.nextViewerSequence(), newer = tracking.nextViewerSequence();
    assert.equal((await post("leave", { ...a, sequence: newer })).status, 204);
    assert.equal((await post("heartbeat", { ...a, sequence: old })).status, 200);
    await synchronized(1);
    assert.equal((await post("heartbeat", { ...a, sequence: tracking.nextViewerSequence() })).status, 200);
    renewing.add(a);
    assert.equal((await post("leave", { ...a, sequence: newer })).status, 204);
    await synchronized(2);

    renewing.delete(a);
    await tracking.leaveViewerSession(origin, a);
    await synchronized(1);
    renewing.delete(b); // process/network loss: no explicit leave
    await sleep(28_000);
    await synchronized(0);
    assert.equal((await fetch(`${origin}/api/viewer-tracking/stats`)).status, 401);
    assert.equal((await post("heartbeat", { sessionId: "X".repeat(43), streamId: a.streamId, sequence: 1 })).status, 401);
    assert.equal((await post("issue", { streamId: "invented" })).status, 400);

    await tracking.sendViewerHeartbeat(origin, a);
    await tracking.sendViewerHeartbeat(origin, b);
    let limited = false;
    for (let i = 0; i < 70; i++) {
      if ((await tracking.sendViewerHeartbeat(origin, a)).status === 429) { limited = true; break; }
    }
    assert.ok(limited, "per-capability heartbeat limit enforced");
    assert.equal((await tracking.sendViewerHeartbeat(origin, b)).status, 200, "another viewer behind the same IP is not rate limited");
    await synchronized(2);
  } finally {
    clearInterval(timer);
    for (const s of sessions) await tracking.leaveViewerSession(origin, s);
    for (const e of engines) e.stop();
  }
});
