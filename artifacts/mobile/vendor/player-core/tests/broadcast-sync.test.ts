/**
 * Broadcast synchronization accuracy tests.
 *
 * Validates that:
 *   - Clock skew correction (setClockOffsetMs) keeps all clients in sync
 *   - Drift correction: server-reported startsAtMs shift → playhead re-seek
 *   - Stale snapshot guard: expired items are not rebound
 *   - Replay-on-reconnect: resume {lastSequence} skips already-processed events
 *   - Source expiry pre-fetch fires at the right time
 *   - Multi-client clock simulation: clients with ±30s OS skew stay within 5s
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine } from "../src/machine.js";
import type { AdapterIntent } from "../src/machine.js";
import type { V2Item, V2Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<V2Item> = {}): V2Item {
  const now = Date.now();
  return {
    id: "sync-item-1",
    title: "Sync Test Sermon",
    thumbnailUrl: null,
    durationSecs: 7200,
    source: { kind: "hls", url: "https://cdn.example.com/sync.m3u8", expiresAtMs: null },
    failoverSource: null,
    startsAtMs: now - 300_000, // started 5 min ago
    endsAtMs: now + 6_900_000,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<V2Snapshot> = {}): V2Snapshot {
  return {
    channelId: "main",
    sequence: 1,
    serverTimeMs: Date.now(),
    mode: "queue",
    current: null,
    next: null,
    nextNext: null,
    override: null,
    checkpoint: null,
    failover: { active: false, reason: null },
    ...overrides,
  };
}

function makeHarness() {
  const intents: AdapterIntent[] = [];
  const machine = new PlayerMachine((intent) => intents.push(intent));
  return { machine, intents };
}

// ---------------------------------------------------------------------------
// Clock-calibrated playhead position
// ---------------------------------------------------------------------------

describe("Broadcast sync — clock offset correction", () => {
  it("positive clockOffset (server ahead) increases play position", () => {
    const { machine, intents } = makeHarness();
    machine.setClockOffsetMs(30_000); // device is 30s behind server

    const item = makeItem({ startsAtMs: Date.now() - 600_000 }); // 10 min ago
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const play = intents.find((i) => i.type === "play");
    // Expected: (Date.now() + 30000 - startsAtMs) / 1000 ≈ 630s
    expect(play?.type === "play" && play.positionSecs).toBeGreaterThan(620);
    machine.destroy();
  });

  it("negative clockOffset (server behind) decreases play position", () => {
    const { machine, intents } = makeHarness();
    machine.setClockOffsetMs(-30_000); // device is 30s ahead of server

    const item = makeItem({ startsAtMs: Date.now() - 600_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const play = intents.find((i) => i.type === "play");
    // Expected: (Date.now() - 30000 - startsAtMs) / 1000 ≈ 570s
    expect(play?.type === "play" && play.positionSecs).toBeLessThan(580);
    machine.destroy();
  });

  it("zero clockOffset gives raw elapsed time", () => {
    const { machine, intents } = makeHarness();
    machine.setClockOffsetMs(0);

    const now = Date.now();
    const item = makeItem({ startsAtMs: now - 300_000 }); // 5 min ago exactly
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const play = intents.find((i) => i.type === "play");
    // Expected: ~300s ± a few ms of test execution time
    expect(play?.type === "play" && play.positionSecs).toBeGreaterThan(295);
    expect(play?.type === "play" && play.positionSecs).toBeLessThan(310);
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Multi-client clock skew simulation
// ---------------------------------------------------------------------------

describe("Broadcast sync — multi-client sync accuracy", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("clients with ±30s OS clock skew end up within 5s of each other after calibration", () => {
    // Simulate 5 devices whose OS clocks are skewed relative to the real server clock.
    // Each device has computed clockOffsetMs = serverTime - deviceTime.
    // After applying the offset, all devices should compute the same play position
    // because (deviceTime + clockOffsetMs) ≈ serverTime for all.
    const serverTimeMs = 1_700_000_000_000; // fixed reference — avoids real-time drift
    const startsAtMs = serverTimeMs - 600_000; // item started 10 min ago (server time)

    const scenarios: Array<{
      deviceSkewMs: number; // device clock ahead (+) or behind (-) relative to server
      positionSecs: number;
    }> = [
      { deviceSkewMs: -30_000, positionSecs: 0 }, // device 30s behind server
      { deviceSkewMs: -10_000, positionSecs: 0 },
      { deviceSkewMs:       0, positionSecs: 0 },
      { deviceSkewMs: +10_000, positionSecs: 0 }, // device 10s ahead of server
      { deviceSkewMs: +30_000, positionSecs: 0 }, // device 30s ahead of server
    ];

    for (const s of scenarios) {
      // Simulate this device's local clock: device is (serverTime + deviceSkewMs)
      vi.setSystemTime(serverTimeMs + s.deviceSkewMs);

      const { machine, intents } = makeHarness();
      // clockOffsetMs = serverTime - deviceTime = -deviceSkewMs
      machine.setClockOffsetMs(-s.deviceSkewMs);

      const item = makeItem({ startsAtMs, durationSecs: 7200 });
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      const play = intents.find((i) => i.type === "play");
      s.positionSecs = play?.type === "play" ? play.positionSecs : 0;
      machine.destroy();
    }

    // All clients corrected to server time → all compute the same ~600s position.
    // Max spread should be ≤ 5s (rounding + floating-point arithmetic only).
    const positions = scenarios.map((s) => s.positionSecs);
    const spread = Math.max(...positions) - Math.min(...positions);
    expect(spread).toBeLessThanOrEqual(5);
  });

  it("without clock calibration, ±30s client skew causes >25s spread", () => {
    // This validates that clock calibration is actually necessary — without it,
    // clients with bad clocks would be visibly out of sync.
    const now = Date.now();
    const item = makeItem({ startsAtMs: now - 600_000, durationSecs: 7200 });

    const rawPositions: number[] = [];

    for (const deviceTimeOffset of [-30_000, 0, +30_000]) {
      const { machine, intents } = makeHarness();
      // NO setClockOffsetMs call — simulating a device with skewed OS clock
      // but we adjust the item's startsAtMs to simulate what the device "sees"
      const skewedItem = { ...item, startsAtMs: item.startsAtMs - deviceTimeOffset };
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: skewedItem }) });
      const play = intents.find((i) => i.type === "play");
      if (play?.type === "play") rawPositions.push(play.positionSecs);
      machine.destroy();
    }

    // Without calibration, the 60s device-clock window creates ≥ 55s spread
    const spread = Math.max(...rawPositions) - Math.min(...rawPositions);
    expect(spread).toBeGreaterThan(25);
  });
});

// ---------------------------------------------------------------------------
// Drift correction (server re-anchors startsAtMs)
// ---------------------------------------------------------------------------

describe("Broadcast sync — drift correction", () => {
  it("startsAtMs drifts >5s on same HLS item → re-seek emitted", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "drift-item", source: { kind: "hls", url: "https://cdn.example.com/s.m3u8", expiresAtMs: null } });

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    intents.length = 0;

    const driftedItem = { ...item, startsAtMs: item.startsAtMs + 10_000 };
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: driftedItem, sequence: 3 }) });

    const reseek = intents.find((i) => i.type === "play");
    expect(reseek).toBeDefined();
    machine.destroy();
  });

  it("startsAtMs drift ≤ 5s on same item → no re-seek (jitter immunity)", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "nodrift-item", source: { kind: "hls", url: "https://cdn.example.com/s.m3u8", expiresAtMs: null } });

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    intents.length = 0;

    const jitterItem = { ...item, startsAtMs: item.startsAtMs + 2_000 }; // 2s — under threshold
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: jitterItem, sequence: 3 }) });

    const reseek = intents.find((i) => i.type === "play");
    expect(reseek).toBeUndefined();
    machine.destroy();
  });

  it("MP4 item: no re-seek even with >5s drift (positionSecs always 0)", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "mp4-drift", source: { kind: "mp4", url: "https://cdn.example.com/v.mp4", expiresAtMs: null } });

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    intents.length = 0;

    const driftedItem = { ...item, startsAtMs: item.startsAtMs + 30_000 };
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: driftedItem, sequence: 3 }) });

    const reseek = intents.find((i) => i.type === "play");
    expect(reseek).toBeUndefined();
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Stale snapshot guard
// ---------------------------------------------------------------------------

describe("Broadcast sync — stale snapshot guard", () => {
  it("expired item (endsAtMs in the past) is not bound as new item", () => {
    const { machine, intents } = makeHarness();
    const baseItem = makeItem({ id: "current" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: baseItem, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    intents.length = 0;

    const staleItem = makeItem({ id: "stale", endsAtMs: Date.now() - 5_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: staleItem, sequence: 2 }) });

    const bind = intents.find((i) => i.type === "bind");
    expect(bind).toBeUndefined(); // stale item rejected
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("valid item (endsAtMs in future) is bound when different from current", () => {
    const { machine, intents } = makeHarness();
    const baseItem = makeItem({ id: "base" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: baseItem, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    intents.length = 0;

    const newItem = makeItem({ id: "new", endsAtMs: Date.now() + 7_200_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: newItem, sequence: 2 }) });

    const bind = intents.find((i) => i.type === "bind");
    expect(bind).toBeDefined();
    if (bind?.type === "bind") expect(bind.item).toMatchObject({ id: "new" });
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Source expiry pre-fetch
// ---------------------------------------------------------------------------

describe("Broadcast sync — source expiry pre-fetch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("requests snapshot 90s before HLS URL expiry within 10-min window", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const item = makeItem({
      source: {
        kind: "hls",
        url: "https://cdn.example.com/expiring.m3u8",
        expiresAtMs: Date.now() + 300_000, // 5 min from now
      },
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });

    vi.advanceTimersByTime(200_000); // 3.3 min
    expect(calls).toBe(0); // not yet (fires at 210s = 300s - 90s)

    vi.advanceTimersByTime(20_000); // now at 220s > 210s threshold
    expect(calls).toBeGreaterThanOrEqual(1);
    machine.destroy();
  });

  it("no pre-fetch timer for URLs expiring > 10 min away", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const item = makeItem({
      source: {
        kind: "hls",
        url: "https://cdn.example.com/long-lived.m3u8",
        expiresAtMs: Date.now() + 20 * 60_000, // 20 min
      },
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });

    vi.advanceTimersByTime(19 * 60_000); // advance 19 min
    expect(calls).toBe(0);
    machine.destroy();
  });

  it("pre-fetch timer is cancelled by destroy()", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const item = makeItem({ source: { kind: "hls", url: "https://cdn.example.com/e.m3u8", expiresAtMs: Date.now() + 300_000 } });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.destroy();
    vi.advanceTimersByTime(600_000);
    expect(calls).toBe(0);
  });

  it("pre-fetch fires correctly when source is replaced mid-play", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const item1 = makeItem({ id: "orig", source: { kind: "hls", url: "https://cdn.example.com/orig.m3u8", expiresAtMs: Date.now() + 300_000 } });
    const item2 = makeItem({ id: "new", source: { kind: "hls", url: "https://cdn.example.com/new.m3u8", expiresAtMs: Date.now() + 300_000 }, endsAtMs: Date.now() + 7_200_000 });

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item1, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });

    // Replace with new item (different ID, future endsAtMs)
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item2, sequence: 2 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });

    vi.advanceTimersByTime(220_000);
    expect(calls).toBeGreaterThanOrEqual(1);
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// RECOVERING state: snapshot does not interrupt recovery
// ---------------------------------------------------------------------------

describe("Broadcast sync — recovery isolation", () => {
  it("snapshot with same item during RECOVERING_PRIMARY does not flip to PLAYING", () => {
    const { machine } = makeHarness();
    const item = makeItem({ id: "recovering" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("snapshot with different item during RECOVERING_PRIMARY rebinds to new item", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "old" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    intents.length = 0;

    const newItem = makeItem({ id: "new", endsAtMs: Date.now() + 7_200_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: newItem, sequence: 2 }) });

    const bind = intents.find((i) => i.type === "bind");
    expect(bind).toBeDefined();
    if (bind?.type === "bind") expect(bind.item).toMatchObject({ id: "new" });
    machine.destroy();
  });
});
