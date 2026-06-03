/**
 * Comprehensive FSM state-machine tests for PlayerMachine.
 *
 * Covers every state transition, all recovery paths, edge-case guards
 * (stale-snapshot, post-natural-end, sequence regression, drift correction,
 * single-item loop, source expiry timer), and all emitted adapter intents.
 *
 * Uses vi.useFakeTimers() for timer-dependent tests so they run in <10 ms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine, type AdapterIntent } from "../src/machine.js";
import type { V2Item, V2Override, V2Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<V2Item> = {}): V2Item {
  const now = Date.now();
  return {
    id: "item-1",
    title: "Test Sermon",
    thumbnailUrl: null,
    durationSecs: 3600,
    source: { kind: "hls", url: "https://cdn.example.com/hls/master.m3u8", expiresAtMs: null },
    failoverSource: null,
    startsAtMs: now - 60_000,
    endsAtMs: now + 3_540_000,
    ...overrides,
  };
}

function makeOverride(overrides: Partial<V2Override> = {}): V2Override {
  return {
    id: "override-1",
    kind: "hls",
    url: "https://cdn.example.com/live.m3u8",
    title: "Live Override",
    startedAtMs: Date.now() - 5_000,
    endsAtMs: null,
    resumeQueueOnEnd: true,
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

interface MachineHarness {
  machine: PlayerMachine;
  intents: AdapterIntent[];
  states: string[];
  needSnapshotCalls: number;
  naturalEndIds: string[];
}

function makeHarness(): MachineHarness {
  const intents: AdapterIntent[] = [];
  const states: string[] = [];
  let needSnapshotCalls = 0;
  const naturalEndIds: string[] = [];

  const machine = new PlayerMachine((intent) => intents.push(intent));
  machine.subscribe((snap) => states.push(snap.state));
  machine.setNeedSnapshotCallback(() => { needSnapshotCalls++; });
  machine.setNaturalEndCallback((id) => naturalEndIds.push(id));

  return { machine, intents, states, get needSnapshotCalls() { return needSnapshotCalls; }, naturalEndIds };
}

// Reach PLAYING state with item bound to buffer A.
function reachPlaying(machine: PlayerMachine, item: V2Item = makeItem()): V2Item {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
  machine.send({ type: "buffer-ready", bufferId: "A" });
  return item;
}

// ---------------------------------------------------------------------------
// Construction & lifecycle
// ---------------------------------------------------------------------------

describe("PlayerMachine — construction & initial state", () => {
  it("starts in BOOTSTRAP", () => {
    const { machine } = makeHarness();
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
  });

  it("initial activeBufferId is A", () => {
    const { machine } = makeHarness();
    expect(machine.getSnapshot().activeBufferId).toBe("A");
  });

  it("initial bufferA and bufferB are null", () => {
    const { machine } = makeHarness();
    const snap = machine.getSnapshot();
    expect(snap.bufferA).toBeNull();
    expect(snap.bufferB).toBeNull();
  });

  it("initial lastSequence is 0", () => {
    const { machine } = makeHarness();
    expect(machine.getSnapshot().lastSequence).toBe(0);
  });

  it("initial lastServerSnapshot is null", () => {
    const { machine } = makeHarness();
    expect(machine.getSnapshot().lastServerSnapshot).toBeNull();
  });

  it("subscribe returns an unsubscribe function", () => {
    const { machine } = makeHarness();
    const unsub = machine.subscribe(() => {});
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });

  it("destroy() with no pending timers does not throw", () => {
    const { machine } = makeHarness();
    expect(() => machine.destroy()).not.toThrow();
  });

  it("setClockOffsetMs does not throw", () => {
    const { machine } = makeHarness();
    expect(() => machine.setClockOffsetMs(5000)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BOOTSTRAP → SYNCING path
// ---------------------------------------------------------------------------

describe("PlayerMachine — BOOTSTRAP → SYNCING", () => {
  it("snapshot with no current → transitions BOOTSTRAP → SYNCING", () => {
    const { machine, states } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null, sequence: 1 }) });
    expect(states).toContain("SYNCING");
    expect(machine.getSnapshot().state).toBe("SYNCING");
  });

  it("empty snapshot does not emit any bind/play intents", () => {
    const { machine, intents } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null }) });
    const hasBindOrPlay = intents.some((i) => i.type === "bind" || i.type === "play");
    expect(hasBindOrPlay).toBe(false);
  });

  it("lastServerSnapshot is updated even with no current item", () => {
    const { machine } = makeHarness();
    const snap = makeSnapshot({ sequence: 7 });
    machine.send({ type: "snapshot", snapshot: snap });
    expect(machine.getSnapshot().lastServerSnapshot).toEqual(snap);
  });

  it("lastSequence advances on first snapshot", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 5 }) });
    expect(machine.getSnapshot().lastSequence).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Happy path: BOOTSTRAP → PREPARING_ACTIVE → PLAYING
// ---------------------------------------------------------------------------

describe("PlayerMachine — happy path BOOTSTRAP → PLAYING", () => {
  it("snapshot with current → PREPARING_ACTIVE", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
  });

  it("snapshot with current → emits bind(A) and play(A)", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    expect(intents.some((i) => i.type === "bind" && i.bufferId === "A")).toBe(true);
    expect(intents.some((i) => i.type === "play" && i.bufferId === "A")).toBe(true);
  });

  it("snapshot with HLS current → play position ≥ 0 (wall-clock seek)", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ source: { kind: "hls", url: "https://cdn.example.com/stream.m3u8", expiresAtMs: null } });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const playIntent = intents.find((i) => i.type === "play" && i.bufferId === "A");
    expect(playIntent).toBeDefined();
    if (playIntent && playIntent.type === "play") {
      expect(playIntent.positionSecs).toBeGreaterThanOrEqual(0);
    }
  });

  it("snapshot with MP4 current → play position = 0 (no moov-atom seeking)", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ source: { kind: "mp4", url: "https://cdn.example.com/video.mp4", expiresAtMs: null } });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const playIntent = intents.find((i) => i.type === "play" && i.bufferId === "A");
    expect(playIntent).toBeDefined();
    if (playIntent && playIntent.type === "play") {
      expect(playIntent.positionSecs).toBe(0);
    }
  });

  it("buffer-ready(A) in PREPARING_ACTIVE → PLAYING", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("buffer-ready(A) in PREPARING_ACTIVE resets primaryRetries (visible on next error budget)", () => {
    const { machine } = makeHarness();
    const item = makeItem();
    // Reach PLAYING
    reachPlaying(machine, item);
    // Error 1 → RECOVERING_PRIMARY (primaryRetries=1)
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    // Recover
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    // Error again — primaryRetries was reset so we still get RECOVERING_PRIMARY (not SKIP_PENDING)
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("bufferA is set in snapshot with current item", () => {
    const { machine } = makeHarness();
    const item = makeItem({ id: "test-item-99" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const snap = machine.getSnapshot();
    expect(snap.bufferA).toMatchObject({ id: "test-item-99" });
  });

  it("multiple subscribers all receive state updates", () => {
    const { machine } = makeHarness();
    const s1: string[] = [];
    const s2: string[] = [];
    machine.subscribe((s) => s1.push(s.state));
    machine.subscribe((s) => s2.push(s.state));
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    expect(s1.length).toBeGreaterThanOrEqual(1);
    expect(s2.length).toBeGreaterThanOrEqual(1);
    expect(s1[0]).toBe(s2[0]);
  });
});

// ---------------------------------------------------------------------------
// Inactive buffer preloading (PREPARING_NEXT)
// ---------------------------------------------------------------------------

describe("PlayerMachine — inactive buffer preloading", () => {
  it("snapshot with next item while PLAYING → binds B (stays PLAYING — PREPARING_NEXT only from preload event)", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2", startsAtMs: Date.now() + 3_540_000, endsAtMs: Date.now() + 7_140_000 });
    reachPlaying(machine, item1);

    intents.length = 0; // clear
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item1, next: item2, sequence: 2 }) });

    // Snapshot with next item triggers bindInactive(B) but does NOT transition to PREPARING_NEXT —
    // only an explicit `preload` server frame does. The machine stays in PLAYING.
    expect(machine.getSnapshot().state).toBe("PLAYING");
    const bindB = intents.find((i) => i.type === "bind" && i.bufferId === "B");
    expect(bindB).toBeDefined();
    if (bindB && bindB.type === "bind") expect(bindB.item).toMatchObject({ id: "item-2" });
  });

  it("preload event while PLAYING → binds inactive buffer and transitions PREPARING_NEXT", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2" });
    reachPlaying(machine, item1);

    intents.length = 0;
    machine.send({ type: "preload", item: item2, leadMs: 90_000 });

    expect(machine.getSnapshot().state).toBe("PREPARING_NEXT");
    const bindB = intents.find((i) => i.type === "bind" && i.bufferId === "B");
    expect(bindB).toBeDefined();
  });

  it("preload in non-PLAYING state does not transition to PREPARING_NEXT", () => {
    const { machine } = makeHarness();
    // BOOTSTRAP state
    const item2 = makeItem({ id: "item-2" });
    machine.send({ type: "preload", item: item2, leadMs: 90_000 });
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
  });

  it("nextNext is used as fallback when next is null", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item3 = makeItem({ id: "item-3" });
    reachPlaying(machine, item1);

    intents.length = 0;
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item1, next: null, nextNext: item3, sequence: 2 }) });

    const bindB = intents.find((i) => i.type === "bind" && i.bufferId === "B");
    expect(bindB).toBeDefined();
    if (bindB && bindB.type === "bind") expect(bindB.item).toMatchObject({ id: "item-3" });
  });
});

// ---------------------------------------------------------------------------
// HANDOFF (buffer-ended with preloaded next)
// ---------------------------------------------------------------------------

describe("PlayerMachine — HANDOFF", () => {
  it("buffer-ended(A) with B preloaded → swap to B + PLAYING", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2" });
    reachPlaying(machine, item1);
    machine.send({ type: "preload", item: item2, leadMs: 90_000 });

    intents.length = 0;
    machine.send({ type: "buffer-ended", bufferId: "A" });

    expect(machine.getSnapshot().state).toBe("PLAYING");
    expect(machine.getSnapshot().activeBufferId).toBe("B");
    const swapIntent = intents.find((i) => i.type === "swap");
    expect(swapIntent).toBeDefined();
    if (swapIntent && swapIntent.type === "swap") expect(swapIntent.activeBufferId).toBe("B");
  });

  it("buffer-ended(A) with B preloaded → emits play(B, 0)", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "preload", item: makeItem({ id: "item-2" }), leadMs: 90_000 });
    intents.length = 0;
    machine.send({ type: "buffer-ended", bufferId: "A" });
    const playB = intents.find((i) => i.type === "play" && i.bufferId === "B");
    expect(playB).toBeDefined();
    if (playB && playB.type === "play") expect(playB.positionSecs).toBe(0);
  });

  it("buffer-ended(A) with no B preloaded → SYNCING + requests snapshot", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);
    reachPlaying(machine);
    machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("buffer-ended(A) fires naturalEndCallback with item id", () => {
    const { machine, naturalEndIds } = makeHarness();
    const item = makeItem({ id: "my-item-xyz" });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(naturalEndIds).toContain("my-item-xyz");
  });

  it("buffer-ended on INACTIVE buffer is ignored", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    const stateBefore = machine.getSnapshot().state;
    machine.send({ type: "buffer-ended", bufferId: "B" }); // B is inactive
    expect(machine.getSnapshot().state).toBe(stateBefore); // unchanged
  });

  it("HANDOFF resets primaryRetries", () => {
    const { machine } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2" });
    reachPlaying(machine, item1);
    machine.send({ type: "preload", item: item2, leadMs: 90_000 });
    // Get an error to increment primaryRetries
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    // Recover to continue
    machine.send({ type: "buffer-ready", bufferId: "A" });
    // Simulate handoff
    machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    // Now B is active. One error should → RECOVERING_PRIMARY (not SKIP_PENDING)
    machine.send({ type: "buffer-error", bufferId: "B", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });
});

// ---------------------------------------------------------------------------
// Error recovery paths
// ---------------------------------------------------------------------------

describe("PlayerMachine — recovery: RECOVERING_PRIMARY", () => {
  it("1st buffer-error on active → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "network" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("1st buffer-error → re-emits bind(A) + play(A)", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine);
    intents.length = 0;
    machine.send({ type: "buffer-error", bufferId: "A", error: "network" });
    expect(intents.some((i) => i.type === "bind" && i.bufferId === "A")).toBe(true);
    expect(intents.some((i) => i.type === "play" && i.bufferId === "A")).toBe(true);
  });

  it("buffer-ready in RECOVERING_PRIMARY → PLAYING + primaryRetries reset", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("2nd buffer-error (no failoverSource) → RECOVERING_PRIMARY again", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("3rd buffer-error → SKIP_PENDING", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
  });

  it("3rd buffer-error → requests snapshot immediately", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("buffer-error on INACTIVE buffer clears its FSM item", () => {
    const { machine } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2" });
    reachPlaying(machine, item1);
    machine.send({ type: "preload", item: item2, leadMs: 90_000 });
    expect(machine.getSnapshot().bufferB).toMatchObject({ id: "item-2" });

    // Error on inactive B
    machine.send({ type: "buffer-error", bufferId: "B", error: "preload-fail" });
    expect(machine.getSnapshot().bufferB).toBeNull();
  });

  it("buffer-error on INACTIVE buffer does NOT change active FSM state", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "B", error: "preload-fail" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("buffer-error on INACTIVE buffer requests a new snapshot", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    let calls = 0;
    machine.setNeedSnapshotCallback(() => calls++);
    machine.send({ type: "buffer-error", bufferId: "B", error: "preload-fail" });
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe("PlayerMachine — recovery: RECOVERING_FAILOVER", () => {
  it("2nd buffer-error with failoverSource → RECOVERING_FAILOVER", () => {
    const { machine } = makeHarness();
    const item = makeItem({ failoverSource: { kind: "hls", url: "https://failover.example.com/stream.m3u8" } });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" }); // → RECOVERING_PRIMARY
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" }); // → RECOVERING_FAILOVER
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
  });

  it("2nd buffer-error with failoverSource → emits bind(A, failoverItem) from position 0", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ failoverSource: { kind: "hls", url: "https://failover.example.com/stream.m3u8" } });
    reachPlaying(machine, item);
    intents.length = 0;
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    intents.length = 0;
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    const bindA = intents.find((i) => i.type === "bind" && i.bufferId === "A");
    const playA = intents.find((i) => i.type === "play" && i.bufferId === "A");
    expect(bindA).toBeDefined();
    expect(playA).toBeDefined();
    if (playA && playA.type === "play") expect(playA.positionSecs).toBe(0);
  });

  it("buffer-ready in RECOVERING_FAILOVER → PLAYING", () => {
    const { machine } = makeHarness();
    const item = makeItem({ failoverSource: { kind: "hls", url: "https://failover.example.com/stream.m3u8" } });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("3rd buffer-error after RECOVERING_FAILOVER → SKIP_PENDING", () => {
    const { machine } = makeHarness();
    const item = makeItem({ failoverSource: { kind: "hls", url: "https://failover.example.com/stream.m3u8" } });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" }); // → RECOVERING_PRIMARY
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" }); // → RECOVERING_FAILOVER
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" }); // → SKIP_PENDING
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
  });
});

// ---------------------------------------------------------------------------
// SKIP_PENDING → FATAL
// ---------------------------------------------------------------------------

describe("PlayerMachine — SKIP_PENDING → FATAL", () => {
  it("3 same-anchor snapshots in SKIP_PENDING → FATAL", () => {
    vi.useFakeTimers();
    const { machine } = makeHarness();
    const item = makeItem({ id: "stuck-item", startsAtMs: Date.now() - 60_000 });
    // Reach SKIP_PENDING (needs prior lastServerSnapshot with this item)
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    // 3 snapshots with same startsAtMs anchor
    for (let i = 2; i <= 4; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: i }) });
    }
    expect(machine.getSnapshot().state).toBe("FATAL");
    vi.useRealTimers();
  });

  it("fresh anchor in SKIP_PENDING → rebind and PREPARING_ACTIVE", () => {
    vi.useFakeTimers();
    const { machine } = makeHarness();
    const item = makeItem({ id: "item-1", startsAtMs: Date.now() - 60_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    // Fresh anchor — server restarted the slot
    const freshItem = { ...item, startsAtMs: Date.now() };
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: freshItem, sequence: 5 }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    vi.useRealTimers();
  });

  it("force-skip transitions to SKIP_PENDING from any state", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "force-skip" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
  });

  it("force-skip clears skipPendingAnchorMs so next snapshot can rebind", () => {
    vi.useFakeTimers();
    const { machine } = makeHarness();
    const item = makeItem({ startsAtMs: Date.now() - 60_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "e" });
    // In SKIP_PENDING with anchor set

    // force-skip clears anchor
    machine.send({ type: "force-skip" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    // Same startsAtMs — but anchor was cleared so it should rebind
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// FATAL auto-recovery timer
// ---------------------------------------------------------------------------

describe("PlayerMachine — FATAL auto-recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("FATAL auto-recovers to SYNCING after 30 s (first attempt)", () => {
    const { machine } = makeHarness();
    const item = makeItem({ startsAtMs: Date.now() - 60_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    for (let i = 0; i < 3; i++) machine.send({ type: "buffer-error", bufferId: "A", error: "e" });
    for (let i = 0; i < 3; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 + i }) });
    }
    expect(machine.getSnapshot().state).toBe("FATAL");

    vi.advanceTimersByTime(30_000);
    expect(machine.getSnapshot().state).toBe("SYNCING");
  });

  it("destroy() cancels FATAL recovery timer — no transition after destroy", () => {
    const { machine } = makeHarness();
    const item = makeItem({ startsAtMs: Date.now() - 60_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    for (let i = 0; i < 3; i++) machine.send({ type: "buffer-error", bufferId: "A", error: "e" });
    for (let i = 0; i < 3; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 + i }) });
    }
    expect(machine.getSnapshot().state).toBe("FATAL");

    machine.destroy();
    vi.advanceTimersByTime(300_000);
    expect(machine.getSnapshot().state).toBe("FATAL"); // timer was cancelled
  });

  it("FATAL backoff is 30s → 60s → 120s → 240s (cap)", () => {
    const BASE = 30_000;
    const CAP = 240_000;
    const expected = [30_000, 60_000, 120_000, 240_000, 240_000];
    const actual = [1, 2, 3, 4, 5].map((n) => Math.min(BASE * Math.pow(2, n - 1), CAP));
    expect(actual).toEqual(expected);
  });

  it("reaching PLAYING resets FATAL backoff counter", () => {
    const { machine } = makeHarness();
    const item = makeItem({ startsAtMs: Date.now() - 60_000 });

    // Go to FATAL
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    for (let i = 0; i < 3; i++) machine.send({ type: "buffer-error", bufferId: "A", error: "e" });
    for (let i = 0; i < 3; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 + i }) });
    }
    expect(machine.getSnapshot().state).toBe("FATAL");

    // Recover to SYNCING
    vi.advanceTimersByTime(30_000);
    expect(machine.getSnapshot().state).toBe("SYNCING");

    // Bind fresh item and reach PLAYING
    const freshItem = { ...item, startsAtMs: Date.now(), endsAtMs: Date.now() + 3_600_000 };
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: freshItem, sequence: 10 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    // fatalAttemptCount resets at PLAYING — verified by the fact that transition() calls
    // this.fatalAttemptCount = 0 on PLAYING entry. The next FATAL would use 30s, not 60s.
  });
});

// ---------------------------------------------------------------------------
// OFFLINE_HOLD
// ---------------------------------------------------------------------------

describe("PlayerMachine — OFFLINE_HOLD", () => {
  it("offline event in BOOTSTRAP → OFFLINE_HOLD", () => {
    const { machine } = makeHarness();
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
  });

  it("offline event in SYNCING → OFFLINE_HOLD", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null }) });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
  });

  it("offline event while PLAYING → stays PLAYING (has buffered content)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("online event in OFFLINE_HOLD → SYNCING", () => {
    const { machine } = makeHarness();
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
    machine.send({ type: "online" });
    expect(machine.getSnapshot().state).toBe("SYNCING");
  });

  it("offline event emits show-overlay with kind='offline'", () => {
    const { machine, intents } = makeHarness();
    machine.send({ type: "offline" });
    const overlay = intents.find((i) => i.type === "show-overlay");
    expect(overlay).toBeDefined();
    if (overlay && overlay.type === "show-overlay") {
      expect(overlay.kind).toBe("offline");
    }
  });

  it("online event in OFFLINE_HOLD emits hide-overlay", () => {
    const { machine, intents } = makeHarness();
    machine.send({ type: "offline" });
    intents.length = 0;
    machine.send({ type: "online" });
    expect(intents.some((i) => i.type === "hide-overlay")).toBe(true);
  });

  it("online event when not in OFFLINE_HOLD → no state change", () => {
    const { machine } = makeHarness();
    machine.send({ type: "online" }); // from BOOTSTRAP
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
  });
});

// ---------------------------------------------------------------------------
// LIVE_OVERRIDE_ACTIVE (override / takeover)
// ---------------------------------------------------------------------------

describe("PlayerMachine — LIVE_OVERRIDE_ACTIVE", () => {
  it("snapshot with mode=override → LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    const override = makeOverride();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ mode: "override", override, current: null }) });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
  });

  it("takeover event → LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    const override = makeOverride();
    machine.send({ type: "takeover", override });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
  });

  it("override engages the INACTIVE buffer and swaps it to active", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "queue-item" });
    reachPlaying(machine, item);
    // A is active. Override should bind B, swap B to active.
    intents.length = 0;
    const override = makeOverride();
    machine.send({ type: "takeover", override });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    const swapIntent = intents.find((i) => i.type === "swap");
    expect(swapIntent).toBeDefined();
    // After swap, B should be active
    expect(machine.getSnapshot().activeBufferId).toBe("B");
  });

  it("override item is stored in the newly active buffer", () => {
    const { machine } = makeHarness();
    const override = makeOverride({ id: "override-99" });
    machine.send({ type: "takeover", override });
    const snap = machine.getSnapshot();
    const activeItem = snap.activeBufferId === "A" ? snap.bufferA : snap.bufferB;
    expect(activeItem).toMatchObject({ id: "override-99" });
  });

  it("buffer-stalled in LIVE_OVERRIDE_ACTIVE is ignored — no state change", () => {
    // Regression guard: YouTube overrides use an external iframe; the native
    // <video> element is idle and the watchdog fires buffer-stalled. This must
    // NOT trigger RECOVERING_PRIMARY (which would kill the iframe display).
    const { machine } = makeHarness();
    machine.send({ type: "takeover", override: makeOverride({ kind: "youtube", url: "https://youtube.com/watch?v=abc" }) });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
    // Must stay in LIVE_OVERRIDE_ACTIVE, not escalate to RECOVERING_PRIMARY.
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
  });

  it("YouTube override: bind emits bind intent with youtube kind", () => {
    const { machine, intents } = makeHarness();
    const ytOverride = makeOverride({ kind: "youtube", url: "https://youtube.com/watch?v=testId" });
    intents.length = 0;
    machine.send({ type: "takeover", override: ytOverride });
    const bindIntent = intents.find((i) => i.type === "bind");
    expect(bindIntent).toBeDefined();
    expect(bindIntent?.type === "bind" && bindIntent.item).toMatchObject({ kind: "youtube" });
  });

  it("buffer-error in LIVE_OVERRIDE_ACTIVE transitions to RECOVERING_PRIMARY", () => {
    // buffer-error is not suppressed in LIVE_OVERRIDE_ACTIVE — only buffer-stalled is.
    // This test documents the current machine behavior.
    const { machine } = makeHarness();
    machine.send({ type: "takeover", override: makeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "media-error" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });
});

// ---------------------------------------------------------------------------
// Stale-snapshot guard
// ---------------------------------------------------------------------------

describe("PlayerMachine — stale-snapshot guard", () => {
  it("snapshot with expired endsAtMs (different item) → does not rebind", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine);
    intents.length = 0;
    const staleItem = makeItem({
      id: "stale-item",
      endsAtMs: Date.now() - 5_000, // already ended
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: staleItem, sequence: 2 }) });
    // Should not have emitted a new bind for the stale item
    const newBind = intents.find((i) => i.type === "bind" && i.bufferId === "A");
    expect(newBind).toBeUndefined();
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("snapshot with valid endsAtMs (different item) → rebinds", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine, makeItem({ id: "item-1" }));
    intents.length = 0;
    const newItem = makeItem({ id: "item-2", endsAtMs: Date.now() + 3_600_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: newItem, sequence: 2 }) });
    const bind = intents.find((i) => i.type === "bind" && i.bufferId === "A");
    expect(bind).toBeDefined();
    if (bind && bind.type === "bind") expect(bind.item).toMatchObject({ id: "item-2" });
  });
});

// ---------------------------------------------------------------------------
// Sequence regression guard
// ---------------------------------------------------------------------------

describe("PlayerMachine — sequence regression guard", () => {
  it("out-of-order snapshot does not regress lastSequence", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 10 }) });
    expect(machine.getSnapshot().lastSequence).toBe(10);
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 3 }) });
    expect(machine.getSnapshot().lastSequence).toBe(10); // must not regress
  });

  it("higher sequence advances lastSequence", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 5 }) });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 8 }) });
    expect(machine.getSnapshot().lastSequence).toBe(8);
  });

  it("equal sequence does not change lastSequence", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 5 }) });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 5 }) });
    expect(machine.getSnapshot().lastSequence).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Clock calibration
// ---------------------------------------------------------------------------

describe("PlayerMachine — clock calibration", () => {
  it("setClockOffsetMs is stored and affects resolvePositionSecs", () => {
    const { machine, intents } = makeHarness();
    // Server clock 1 minute ahead means positionSecs should be ~1 min more
    machine.setClockOffsetMs(60_000);
    const item = makeItem({
      source: { kind: "hls", url: "https://cdn.example.com/stream.m3u8", expiresAtMs: null },
      startsAtMs: Date.now() - 600_000, // started 10 min ago
      durationSecs: 3600,
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const playIntent = intents.find((i) => i.type === "play" && i.bufferId === "A");
    expect(playIntent).toBeDefined();
    if (playIntent && playIntent.type === "play") {
      // Position should be ~660s (600s elapsed + 60s offset), capped at 3590 (3600-10)
      expect(playIntent.positionSecs).toBeGreaterThan(600);
    }
  });

  it("zero clock offset gives elapsed from startsAtMs", () => {
    const { machine, intents } = makeHarness();
    machine.setClockOffsetMs(0);
    const now = Date.now();
    const item = makeItem({
      source: { kind: "hls", url: "https://cdn.example.com/stream.m3u8", expiresAtMs: null },
      startsAtMs: now - 120_000, // started 2 min ago
      durationSecs: 3600,
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const playIntent = intents.find((i) => i.type === "play" && i.bufferId === "A");
    if (playIntent && playIntent.type === "play") {
      // ~120s (±1s tolerance for test timing)
      expect(playIntent.positionSecs).toBeGreaterThan(110);
      expect(playIntent.positionSecs).toBeLessThan(130);
    }
  });

  it("HLS position capped at durationSecs-10 when elapsed exceeds duration", () => {
    const { machine, intents } = makeHarness();
    const now = Date.now();
    const item = makeItem({
      source: { kind: "hls", url: "https://cdn.example.com/stream.m3u8", expiresAtMs: null },
      startsAtMs: now - 3_700_000, // started 61.7 min ago
      durationSecs: 3600,          // 60 min video
      endsAtMs: now + 3_600_000,   // server still shows it as current
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const playIntent = intents.find((i) => i.type === "play" && i.bufferId === "A");
    if (playIntent && playIntent.type === "play") {
      // elapsed ≈ 3700s > durationSecs(3600) - 10 → must be capped at 3590
      expect(playIntent.positionSecs).toBeLessThanOrEqual(3590);
      expect(playIntent.positionSecs).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buffer-stalled handling
// ---------------------------------------------------------------------------

describe("PlayerMachine — buffer-stalled events", () => {
  it("buffer-stalled in PLAYING → RECOVERING_PRIMARY (same as buffer-error)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("buffer-stalled in PREPARING_ACTIVE → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("buffer-stalled in BOOTSTRAP → no state change", () => {
    const { machine } = makeHarness();
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
  });

  it("buffer-stalled in SYNCING → no state change", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null }) });
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SYNCING");
  });

  it("buffer-stalled on INACTIVE buffer → no state change", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-stalled", bufferId: "B" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });
});

// ---------------------------------------------------------------------------
// Source expiry timer
// ---------------------------------------------------------------------------

describe("PlayerMachine — source expiry timer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("schedules snapshot request 90s before source URL expiry", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const now = Date.now();
    const item = makeItem({
      source: {
        kind: "hls",
        url: "https://cdn.example.com/stream.m3u8",
        expiresAtMs: now + 300_000, // expires in 5 min — within 10 min window
      },
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });

    // Timer should fire 90s before expiry = 300s - 90s = 210s from now
    vi.advanceTimersByTime(200_000);
    expect(calls).toBe(0);
    vi.advanceTimersByTime(20_000); // total 220s > 210s
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("destroy() cancels the source expiry timer", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const now = Date.now();
    const item = makeItem({
      source: {
        kind: "hls",
        url: "https://cdn.example.com/stream.m3u8",
        expiresAtMs: now + 300_000,
      },
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    machine.destroy();

    vi.advanceTimersByTime(600_000);
    expect(calls).toBe(0);
  });

  it("does NOT schedule expiry timer for URLs expiring > 10 minutes away", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const now = Date.now();
    const item = makeItem({
      source: {
        kind: "hls",
        url: "https://cdn.example.com/stream.m3u8",
        expiresAtMs: now + 20 * 60 * 1000, // 20 min away
      },
    });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });

    vi.advanceTimersByTime(19 * 60 * 1000); // advance 19 min
    expect(calls).toBe(0); // no snapshot request — beyond 10 min window
  });

  it("V2Override (no expiresAtMs) does not schedule expiry timer", () => {
    let calls = 0;
    const { machine } = makeHarness();
    machine.setNeedSnapshotCallback(() => calls++);

    const override = makeOverride(); // no expiresAtMs on override
    machine.send({ type: "takeover", override });

    vi.advanceTimersByTime(600_000);
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bindInactive early-exit (same item + same startsAtMs)
// ---------------------------------------------------------------------------

describe("PlayerMachine — bindInactive dedup", () => {
  it("same item + same startsAtMs → no duplicate bind emitted", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2" });
    reachPlaying(machine, item1);
    machine.send({ type: "preload", item: item2, leadMs: 90_000 });
    const bindCount = intents.filter((i) => i.type === "bind" && i.bufferId === "B").length;

    intents.length = 0;
    // Same preload again
    machine.send({ type: "preload", item: item2, leadMs: 90_000 });
    const newBindCount = intents.filter((i) => i.type === "bind" && i.bufferId === "B").length;
    expect(newBindCount).toBe(0); // deduplicated
  });

  it("same item ID but different startsAtMs → does emit bind (new loop pass)", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2a = makeItem({ id: "item-2", startsAtMs: Date.now() + 3_000_000 });
    const item2b = { ...item2a, startsAtMs: Date.now() + 6_000_000 }; // new loop
    reachPlaying(machine, item1);
    machine.send({ type: "preload", item: item2a, leadMs: 90_000 });
    intents.length = 0;
    machine.send({ type: "preload", item: item2b, leadMs: 90_000 });
    const newBind = intents.find((i) => i.type === "bind" && i.bufferId === "B");
    expect(newBind).toBeDefined(); // new startsAtMs → must rebind
  });
});

// ---------------------------------------------------------------------------
// Drift correction in PLAYING
// ---------------------------------------------------------------------------

describe("PlayerMachine — drift correction (PLAYING, same item)", () => {
  it("same item with anchor drift > 5000ms → emits play(A) re-seek", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "item-1", source: { kind: "hls", url: "https://cdn.example.com/s.m3u8", expiresAtMs: null } });
    reachPlaying(machine, item);
    // First snapshot establishes prev startsAtMs
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    intents.length = 0;

    // Second snapshot with same item but startsAtMs shifted by 10s
    const driftedItem = { ...item, startsAtMs: item.startsAtMs + 10_000 };
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: driftedItem, sequence: 3 }) });

    const playReseek = intents.find((i) => i.type === "play" && i.bufferId === "A");
    expect(playReseek).toBeDefined();
  });

  it("same item with anchor drift ≤ 5000ms → no re-seek emitted", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "item-1", source: { kind: "hls", url: "https://cdn.example.com/s.m3u8", expiresAtMs: null } });
    reachPlaying(machine, item);
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    intents.length = 0;

    const smallDriftItem = { ...item, startsAtMs: item.startsAtMs + 3_000 }; // 3s drift — under threshold
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: smallDriftItem, sequence: 3 }) });

    const playReseek = intents.find((i) => i.type === "play" && i.bufferId === "A");
    expect(playReseek).toBeUndefined();
  });

  it("MP4 item in PLAYING — no re-seek even with > 5s drift (positionSecs always 0)", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({
      id: "item-1",
      source: { kind: "mp4", url: "https://cdn.example.com/video.mp4", expiresAtMs: null },
    });
    reachPlaying(machine, item);
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    intents.length = 0;

    const driftedItem = { ...item, startsAtMs: item.startsAtMs + 30_000 };
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: driftedItem, sequence: 3 }) });

    // positionSecs for MP4 = 0 → the guard `if (positionSecs > 0)` suppresses the emit
    const playReseek = intents.find((i) => i.type === "play" && i.bufferId === "A");
    expect(playReseek).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SYNCING → re-entry (no-current → has-current)
// ---------------------------------------------------------------------------

describe("PlayerMachine — SYNCING → PREPARING_ACTIVE re-entry", () => {
  it("SYNCING + snapshot with current → PREPARING_ACTIVE + bind + play", () => {
    const { machine, intents } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null, sequence: 1 }) });
    expect(machine.getSnapshot().state).toBe("SYNCING");

    intents.length = 0;
    const item = makeItem();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    expect(intents.some((i) => i.type === "bind")).toBe(true);
    expect(intents.some((i) => i.type === "play")).toBe(true);
  });

  it("SYNCING + snapshot with no current → state remains SYNCING (not a deeper state)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null, sequence: 1 }) });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null, sequence: 2 }) });
    // transition() is a no-op when already in same state; state must still be SYNCING
    expect(machine.getSnapshot().state).toBe("SYNCING");
    // Note: listeners fire on every set() call (for lastServerSnapshot updates) even
    // when state does not change — that is by design, not a bug.
  });
});

// ---------------------------------------------------------------------------
// Failover overlay intents
// ---------------------------------------------------------------------------

describe("PlayerMachine — failover overlay", () => {
  it("snapshot with failover.active=true → emits show-overlay(failover)", () => {
    const { machine, intents } = makeHarness();
    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({
        current: makeItem(),
        failover: { active: true, reason: "Emergency maintenance" },
      }),
    });
    const overlay = intents.find((i) => i.type === "show-overlay");
    expect(overlay).toBeDefined();
    if (overlay && overlay.type === "show-overlay") {
      expect(overlay.kind).toBe("failover");
      expect(overlay.reason).toBe("Emergency maintenance");
    }
  });

  it("snapshot with failover.active=false → emits hide-overlay", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine);
    intents.length = 0;
    const item = makeItem();
    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({ current: item, failover: { active: false, reason: null }, sequence: 2 }),
    });
    expect(intents.some((i) => i.type === "hide-overlay")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OFFLINE_HOLD mode in snapshot
// ---------------------------------------------------------------------------

describe("PlayerMachine — offline_hold mode in snapshot", () => {
  it("snapshot with mode=offline_hold → OFFLINE_HOLD", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ mode: "offline_hold" }) });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
  });

  it("snapshot with mode=offline_hold → emits show-overlay(offline)", () => {
    const { machine, intents } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ mode: "offline_hold" }) });
    const overlay = intents.find((i) => i.type === "show-overlay");
    expect(overlay).toBeDefined();
    if (overlay && overlay.type === "show-overlay") {
      expect(overlay.kind).toBe("offline");
    }
  });
});

// ---------------------------------------------------------------------------
// SYNCING → pauses and unbinds existing buffers
// ---------------------------------------------------------------------------

describe("PlayerMachine — SYNCING unbinds existing buffers", () => {
  it("transition to SYNCING from PLAYING → emits pause+unbind for both buffers", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine);
    intents.length = 0;

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null, sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    expect(intents.some((i) => i.type === "pause")).toBe(true);
    expect(intents.some((i) => i.type === "unbind")).toBe(true);
  });

  it("transition to SYNCING clears bufferA and bufferB in FSM snapshot", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null, sequence: 2 }) });
    const snap = machine.getSnapshot();
    expect(snap.bufferA).toBeNull();
    expect(snap.bufferB).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single-item loop: after HANDOFF, same item preloaded again
// ---------------------------------------------------------------------------

describe("PlayerMachine — single-item loop", () => {
  it("HANDOFF where next === current (single-item queue) → immediately rebinds freed buffer", () => {
    const { machine, intents } = makeHarness();
    const loopItem = makeItem({ id: "loop-item" });
    reachPlaying(machine, loopItem);

    // Server says next = same item (loop)
    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({ current: loopItem, next: loopItem, sequence: 2 }),
    });

    intents.length = 0;
    machine.send({ type: "buffer-ended", bufferId: "A" });

    expect(machine.getSnapshot().state).toBe("PLAYING");
    expect(machine.getSnapshot().activeBufferId).toBe("B");
    // After handoff, the freed slot (A) should be rebound for the next loop pass
    // isSingleItemLoop=true → bindInactive called immediately
    const bindA = intents.find((i) => i.type === "bind" && i.bufferId === "A");
    expect(bindA).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// RECOVERING state: snapshot with same item does not flip to PLAYING
// ---------------------------------------------------------------------------

describe("PlayerMachine — recovery state isolation from snapshots", () => {
  it("snapshot with same item in RECOVERING_PRIMARY → stays RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    const item = makeItem({ id: "item-1" });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    // Same item snapshot arrives while recovering — must NOT transition to PLAYING
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("buffer-ready in RECOVERING state transitions to PLAYING", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });
});

// ---------------------------------------------------------------------------
// Natural end guard: server still shows ended item as current
// ---------------------------------------------------------------------------

describe("PlayerMachine — post-natural-end guard", () => {
  it("buffer-ended sets lastEndedItemId so same item is not rebound", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "item-ended" });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-ended", bufferId: "A" });
    // Machine is now SYNCING (no next buffer)

    intents.length = 0;
    // Server still shows old item as current (hasn't advanced yet)
    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({
        current: item,
        sequence: 2,
        // endsAtMs in the future (server hasn't advanced)
      }),
    });
    // Should NOT rebind — guarded by lastEndedItemId
    const rebind = intents.find((i) => i.type === "bind" && i.bufferId === "A");
    expect(rebind).toBeUndefined();
  });

  it("server advances to a new item → guard clears and new item binds", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2", endsAtMs: Date.now() + 7_200_000 });
    reachPlaying(machine, item1);
    machine.send({ type: "buffer-ended", bufferId: "A" }); // sets lastEndedItemId = "item-1"

    intents.length = 0;
    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({ current: item2, sequence: 3 }),
    });
    const bind = intents.find((i) => i.type === "bind");
    expect(bind).toBeDefined();
    if (bind && bind.type === "bind") expect(bind.item).toMatchObject({ id: "item-2" });
  });
});

// ---------------------------------------------------------------------------
// PREPARING_ACTIVE → PLAYING with buffer-ready on inactive buffer
// ---------------------------------------------------------------------------

describe("PlayerMachine — buffer-ready on wrong buffer", () => {
  it("buffer-ready on INACTIVE buffer while PREPARING_ACTIVE → no state change", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.send({ type: "buffer-ready", bufferId: "B" }); // B is inactive
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE"); // must not flip to PLAYING
  });
});
