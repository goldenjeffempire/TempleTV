/**
 * Opt-in integration suite against the DEVELOPMENT database. Never run on
 * production. Creates only test-owned credentials/stream and removes them.
 * Executes actual parameterized PostgreSQL queries; no in-memory store mocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

test("durable viewer lifecycle under concurrent clients and instance recovery", {
  skip: process.env.RUN_VIEWER_DB_TESTS !== "1", timeout: 120_000,
}, async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development-only integration test");
  const { pgPool } = await import("../../src/infrastructure/db.js");
  const { ViewerPresenceStore, InvalidViewerCredential, credentialHash } =
    await import("../../src/modules/viewer-tracking/viewer-presence.store.js");
  const { ViewerTrackingService } = await import("../../src/modules/viewer-tracking/viewer-tracking.service.js");
  const stream = `test-viewer-${randomUUID()}`;
  const store = new ViewerPresenceStore(pgPool, 8);
  const tokens: string[] = [];
  const services: InstanceType<typeof ViewerTrackingService>[] = [];
  async function issue(user?: string) {
    const token = await store.issue(user);
    tokens.push(token);
    return token;
  }
  async function count() { return (await store.counts()).find(s => s.streamId === stream)?.current ?? 0; }
  try {
    await store.initialize();
    const start = performance.now();
    const viewers = await Promise.all(Array.from({ length: 100 }, () => issue()));
    await Promise.all(viewers.map(token => store.record(token, stream, 1, true, "mobile")));
    assert.equal(await count(), 100, "100 distinct active viewers");
    console.log(JSON.stringify({ concurrentViewers: 100, joinDurationMs: Math.round(performance.now() - start) }));

    await Promise.all(viewers.map(token => store.record(token, stream, 2, true, "mobile")));
    assert.equal(await count(), 100, "repeat heartbeats must not double-count");
    assert.equal(await store.issue(undefined, viewers[0]), viewers[0], "reconnect resumes installation credential");
    assert.equal(await store.issue("viewer-test-login", viewers[0]), viewers[0], "login preserves installation identity");
    const signedInDevice = await issue("viewer-test-login");
    await store.record(signedInDevice, stream, 1, true);
    assert.equal(await count(), 100, "signed-in devices share an owner, not duplicate guest/user leases");
    await store.record(signedInDevice, stream, 2, false);
    assert.equal(await store.issue(undefined, viewers[0]), viewers[0], "logout preserves installation identity");
    assert.equal(await count(), 100);

    const first = viewers[0]!;
    await store.record(first, stream, 4, false);
    await store.record(first, stream, 3, true);
    assert.equal(await count(), 99, "late heartbeat cannot undo newer leave");
    await store.record(first, stream, 5, true);
    await store.record(first, stream, 4, false);
    assert.equal(await count(), 100, "late leave cannot remove a newer reconnect");
    assert.equal(await store.nextSequence(first), 6);

    // Separate devices belonging to one authenticated user are one viewer.
    const user = `test-user-${randomUUID()}`;
    const [deviceA, deviceB] = await Promise.all([issue(user), issue(user)]);
    await Promise.all([deviceA, deviceB].map(token => store.record(token, stream, 1, true)));
    assert.equal(await count(), 101, "deduplicate authenticated viewer identity");
    await store.record(deviceA, stream, 2, false);
    assert.equal(await count(), 101, "one device leaving must not remove another active device");
    await store.record(deviceB, stream, 2, false);

    await assert.rejects(store.record(randomUUID(), stream, 1, true), InvalidViewerCredential);
    assert.equal(await count(), 100, "invented sessions cannot inflate counts");

    // Two actual service objects/DB connections, same shared authority; restart
    // a service rather than killing the shared API or broadcast daemon.
    const a = new ViewerTrackingService(store);
    const b = new ViewerTrackingService(new ViewerPresenceStore(pgPool, 8));
    services.push(a, b);
    await a.start();
    await b.start();
    assert.equal((await a.getStats(stream)).totalCurrent, 100);
    assert.equal((await b.getStats(stream)).totalCurrent, 100);
    a.stop();
    const restarted = new ViewerTrackingService(new ViewerPresenceStore(pgPool, 8));
    services.push(restarted);
    await restarted.start();
    assert.equal((await restarted.getStats(stream)).totalCurrent, 100, "restart recovers unexpired leases");

    // Rapid concurrent exits including duplicates are idempotent.
    await Promise.all(viewers.slice(0, 50).flatMap(token => [
      store.record(token, stream, 10, false), store.record(token, stream, 10, false),
    ]));
    assert.equal(await count(), 50);
    await Promise.all(viewers.slice(0, 50).map(token => store.record(token, stream, 11, true)));
    assert.equal(await count(), 100);

    // Crashed/offline clients stop heartbeats. Database-clock expiry must
    // recover all the way to zero without any surviving viewer requesting it.
    const changes: number[] = [];
    b.on("count", (event: { streamId: string; count: number }) => {
      if (event.streamId === stream) changes.push(event.count);
    });
    await new Promise(resolve => setTimeout(resolve, 10500));
    assert.equal(await count(), 0);
    assert.ok(changes.includes(0), "sweep emits final zero for disconnected clients");
    assert.equal((await restarted.getStats(stream)).totalCurrent, 0);

    // Credentials outlive active leases. Reconnect after TTL reuses the
    // capability, not a second anonymous installation identity.
    await store.record(first, stream, 20, true);
    const afterExpiry = await store.issue(undefined, first);
    assert.equal(afterExpiry, first);
    const newInstance = new ViewerTrackingService(new ViewerPresenceStore(pgPool, 8));
    services.push(newInstance);
    await newInstance.start();
    assert.equal((await newInstance.getStats(stream)).totalCurrent, 1);
    assert.ok((await newInstance.getStats(stream)).totalPeak >= 100, "peak persists across instance restarts");

    // Exercise genuine store errors without disrupting the shared DB.
    const offlineStore = new ViewerPresenceStore({
      query: async () => { throw new Error("test connection unavailable"); },
    } as unknown as typeof pgPool, 4);
    const offline = new ViewerTrackingService(offlineStore);
    await assert.rejects(offline.getStats(stream), /unavailable/);
    assert.equal(offline.currentCount(stream), null, "outage is unknown, never fake zero");
    console.log("Verified duplicate, leave/rejoin ordering, multiple instances, TTL-to-zero, restart persistence and explicit outage handling.");
  } finally {
    for (const service of services) service.stop();
    await pgPool.query(`DELETE FROM viewer_presence_credentials WHERE token_hash = ANY($1::text[])`,
      [tokens.map(credentialHash)]);
    await pgPool.query(`DELETE FROM viewer_presence_metrics WHERE stream_id = $1`, [stream]);
    await pgPool.end();
  }
});
