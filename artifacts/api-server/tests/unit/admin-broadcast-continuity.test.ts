import assert from "node:assert/strict";
import { test } from "node:test";
import { createNaturalEndNotifier } from "../../../../lib/player-core/src/natural-end-notifier.js";
import { V2Transport } from "../../../../lib/player-core/src/transport.js";
import { createAdminBroadcastStatusReader } from "../../src/modules/admin-ops/broadcast-status-reader.js";
import { REPAIR_LOG_OUTCOMES } from "../../../../lib/db/src/schema/queue-asset-health.js";
import { z } from "zod";
import { assetHealthRowSchema } from "../../src/modules/broadcast-v2/domain/asset-health.schemas.js";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const fixture = { mode: "queue", serverTimeMs: 1_000_000, sequence: 42,
  current: { id: "fixture-video" }, override: null };
// Match the real REST wire contract, not the flat WS snapshot shape.
const response = (value: unknown) => new Response(JSON.stringify({ state: value }));

test("historical blocked repair outcomes remain valid rather than breaking health responses", () => {
  const outcome = z.enum(REPAIR_LOG_OUTCOMES);
  assert.equal(outcome.parse("blocked"), "blocked");
  for (const value of ["success", "failure", "pending", "skipped"]) assert.equal(outcome.parse(value), value);
  assert.equal(outcome.safeParse("invented-outcome").success, false);
  const legacyRow = { id: "fixture", queueItemId: "fixture-item", videoId: null,
    state: "healthy", repairAttempts: 1, lastRepairAt: null, nextRetryAt: null,
    lastErrorCode: null, lastError: null, suggestedFix: null, sourceHash: null,
    autoRepairPaused: false, createdAt: "2026-11-12T00:00:00Z",
    updatedAt: "2026-11-12T00:00:00Z",
    repairLog: [{ ts: "2026-11-12T00:00:00Z", actor: "system",
      action: "terminal-block", detail: "Historical repair outcome", outcome: "blocked" }] };
  assert.equal(assetHealthRowSchema.safeParse(legacyRow).success, true);
});

test("observer transport cannot submit drift telemetry, while audience telemetry is preserved", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => { calls++; assert.match(String(url), /\/report-position$/); return new Response(""); };
  const observer = new V2Transport({ baseUrl: "https://example.invalid", observer: true, onPlayerEvent() {} });
  const viewer = new V2Transport({ baseUrl: "https://example.invalid", onPlayerEvent() {} });
  const internal = (transport: V2Transport) => transport as unknown as {
    startDriftReporter(): void; sendDriftReport(id: string, position: number): Promise<void>;
    driftReportTimer: unknown;
  };
  try {
    internal(observer).startDriftReporter();
    assert.equal(internal(observer).driftReportTimer, null);
    await internal(observer).sendDriftReport("fixture-video", 20_000);
    assert.equal(calls, 0);
    await internal(viewer).sendDriftReport("fixture-video", 20_000);
    assert.equal(calls, 1);
  } finally { observer.stop(); viewer.stop(); globalThis.fetch = originalFetch; }
});

test("admin observers never send natural-end mutations or retries", async () => {
  let calls = 0;
  const notify = createNaturalEndNotifier({
    baseUrl: "https://example.invalid", observer: true, isActive: () => true,
    getAuthToken: () => null, requestSnapshot: () => { calls++; },
    fetcher: async () => { calls++; throw new Error("offline"); },
    schedule: () => { calls++; },
  });
  for (let i = 0; i < 100; i++) notify("fixture-video");
  await settle(); assert.equal(calls, 0);
});
test("viewer reporting stops when detached or logged out, including pending retries", async () => {
  let active = true, calls = 0;
  const pending: (() => void)[] = [];
  const notify = createNaturalEndNotifier({
    baseUrl: "https://example.invalid", observer: false, isActive: () => active,
    getAuthToken: () => null, requestSnapshot() {},
    fetcher: async () => { calls++; throw new Error("offline"); },
    schedule: fn => pending.push(fn),
  });
  notify("fixture-video"); await settle();
  assert.equal(calls, 1); assert.equal(pending.length, 1);
  active = false; pending[0](); notify("fixture-video"); await settle();
  assert.equal(calls, 1);
});
test("real viewers retain bounded retry/backoff and successful signaling", async () => {
  let calls = 0, snapshots = 0, token = "fixture-token";
  const pending: (() => void)[] = [], delays: number[] = [];
  const notify = createNaturalEndNotifier({
    baseUrl: "https://example.invalid", observer: false, isActive: () => true,
    getAuthToken: () => token, requestSnapshot: () => snapshots++,
    fetcher: async (_url, options) => {
      calls++; assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
      return new Response("", { status: calls < 4 ? 503 : 200 });
    },
    schedule: (fn, delay) => { pending.push(fn); delays.push(delay); },
  });
  notify("fixture-video"); await settle();
  while (pending.length) { token += "-rotated"; pending.shift()!(); await settle(); }
  assert.equal(calls, 4); assert.equal(snapshots, 0);
  assert.deepEqual(delays, [300, 800, 2_000]);
});
test("proxy monitoring uses the live daemon instead of a stopped local engine", async () => {
  const read = createAdminBroadcastStatusReader({
    daemonUrl: "http://daemon:9000/",
    localSnapshot: () => ({ isLive: false, deviceCount: 7 }),
    fetcher: async url => { assert.equal(url, "http://daemon:9000/api/v1/broadcast-v2/state"); return response(fixture); },
  });
  const value = await read(); assert.equal(value?.isLive, true); assert.equal(value?.deviceCount, 7);
});
test("unknown/unreachable daemon is not falsely presented as OFF AIR", async () => {
  for (const value of [{}, { ...fixture, current: false }]) {
    const read = createAdminBroadcastStatusReader({ daemonUrl: "http://daemon:9000",
      localSnapshot: () => ({ isLive: false }), fetcher: async () => response(value) });
    assert.equal(await read(), null);
  }
  const read = createAdminBroadcastStatusReader({ daemonUrl: "http://daemon:9000",
    localSnapshot: () => ({ isLive: false }), fetcher: async () => { throw new Error("offline"); } });
  assert.equal(await read(), null);
});
test("many admin consoles coalesce status reads and recover from a cached failure", async () => {
  let now = 1, calls = 0, healthy = false;
  const read = createAdminBroadcastStatusReader({
    daemonUrl: "http://daemon:9000", now: () => now, localSnapshot: () => ({ isLive: false }),
    fetcher: async () => { calls++; if (!healthy) throw new Error("offline"); return response(fixture); },
  });
  assert.ok((await Promise.all(Array.from({ length: 50 }, () => read()))).every(v => v === null));
  assert.equal(calls, 1);
  healthy = true; now += 5_001;
  assert.equal((await read())?.isLive, true); assert.equal(calls, 2);
});
test("standalone mode and deliberate offline hold remain truthful", async () => {
  assert.equal((await createAdminBroadcastStatusReader({ localSnapshot: () => ({ isLive: true }) })())?.isLive, true);
  const read = createAdminBroadcastStatusReader({ daemonUrl: "http://daemon:9000",
    localSnapshot: () => ({ isLive: true }), fetcher: async () => response({ ...fixture, mode: "offline_hold" }) });
  assert.equal((await read())?.isLive, false);
});
test("a synchronous transport failure cannot permanently pin the single-flight cache", async () => {
  let now = 1, calls = 0;
  const read = createAdminBroadcastStatusReader({
    daemonUrl: "http://daemon:9000", now: () => now, localSnapshot: () => ({ isLive: false }),
    fetcher: () => { if (++calls === 1) throw new Error("transport initialization failed"); return Promise.resolve(response(fixture)); },
  });
  assert.equal(await read(), null); now += 5_001;
  assert.equal((await read())?.isLive, true);
});
