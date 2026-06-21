/**
 * FSM state-transition matrix tests for PlayerMachine.
 *
 * Validates that each (state, event) pair produces the expected outcome:
 *   - Correct output state
 *   - Correct AdapterIntent emitted (if any)
 *   - Correct silent ignore for inapplicable events
 *
 * Acts as a regression guard: any change to the FSM's transition table
 * surfaces here immediately as a test failure.
 *
 * NOTE: `activeBufferId` is always "A" at boot (initialised in PlayerMachine
 * constructor), so tests that need to send a buffer event can hardcode "A"
 * without querying getSnapshot() first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine } from "../src/machine.js";
import type { AdapterIntent } from "../src/machine.js";
import type { V2Item, V2Override, V2Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STATES = new Set([
  "BOOTSTRAP", "SYNCING", "PREPARING_ACTIVE", "PLAYING",
  "PREPARING_NEXT", "HANDOFF", "RECOVERING_PRIMARY", "RECOVERING_FAILOVER",
  "SKIP_PENDING", "FATAL", "OFFLINE_HOLD", "LIVE_OVERRIDE_ACTIVE",
]);

function makeItem(id = "item-1", overrides: Partial<V2Item> = {}): V2Item {
  const now = Date.now();
  return {
    id,
    title: `Sermon ${id}`,
    thumbnailUrl: null,
    durationSecs: 3600,
    source: { kind: "hls", url: `https://cdn.example.com/${id}.m3u8`, expiresAtMs: null },
    failoverSource: null,
    startsAtMs: now - 60_000,
    endsAtMs: now + 3_540_000,
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

function makeOverride(kind: V2Override["kind"] = "hls"): V2Override {
  return {
    id: "ov-1",
    kind,
    url: "https://cdn.example.com/live.m3u8",
    title: "Live Override",
    startedAtMs: Date.now(),
    endsAtMs: null,
    resumeQueueOnEnd: true,
  };
}

function makeHarness() {
  const intents: AdapterIntent[] = [];
  const machine = new PlayerMachine((intent) => intents.push(intent));
  return { machine, intents };
}

function reachPlaying(machine: PlayerMachine, item: V2Item = makeItem()): void {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
  machine.send({ type: "buffer-ready", bufferId: "A" });
  expect(machine.getSnapshot().state).toBe("PLAYING");
}

function reachRecoveringPrimary(machine: PlayerMachine): void {
  reachPlaying(machine);
  machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
  expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
}

// ---------------------------------------------------------------------------
// BOOTSTRAP state
// ---------------------------------------------------------------------------

describe("FSM matrix — BOOTSTRAP", () => {
  it("starts in BOOTSTRAP", () => {
    const { machine } = makeHarness();
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
    machine.destroy();
  });

  it("BOOTSTRAP + online → stays BOOTSTRAP (no transport yet)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "online" });
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
    machine.destroy();
  });

  it("BOOTSTRAP + offline → OFFLINE_HOLD", () => {
    const { machine } = makeHarness();
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
    machine.destroy();
  });

  it("BOOTSTRAP + snapshot(no current) → SYNCING", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot() });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.destroy();
  });

  it("BOOTSTRAP + snapshot(with current) → PREPARING_ACTIVE", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.destroy();
  });

  it("BOOTSTRAP + buffer-ready → stays BOOTSTRAP (no bind pending)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
    machine.destroy();
  });

  it("BOOTSTRAP + buffer-error on active A → RECOVERING_PRIMARY (machine processes error even without bind)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "buffer-error", bufferId: "A", error: "e" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// SYNCING state
// ---------------------------------------------------------------------------

describe("FSM matrix — SYNCING", () => {
  it("SYNCING + snapshot(with current) → PREPARING_ACTIVE → buffer-ready → PLAYING", () => {
    const { machine } = makeHarness();
    const item = makeItem();
    machine.send({ type: "snapshot", snapshot: makeSnapshot() });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("SYNCING + offline → OFFLINE_HOLD", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot() });
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
    machine.destroy();
  });

  it("SYNCING + snapshot(no current) → stays SYNCING", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot() });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// PREPARING_ACTIVE state
// ---------------------------------------------------------------------------

describe("FSM matrix — PREPARING_ACTIVE", () => {
  it("PREPARING_ACTIVE + buffer-ready (A) → PLAYING", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("PREPARING_ACTIVE + buffer-ready on inactive B → stays PREPARING_ACTIVE", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    machine.send({ type: "buffer-ready", bufferId: "B" });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.destroy();
  });

  it("PREPARING_ACTIVE + buffer-error (A) → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("PREPARING_ACTIVE + buffer-stalled (A) → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem() }) });
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// PLAYING state
// ---------------------------------------------------------------------------

describe("FSM matrix — PLAYING", () => {
  it("PLAYING + buffer-error → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("PLAYING + buffer-stalled → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("PLAYING + buffer-ended (no preloaded inactive) → SYNCING", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.destroy();
  });

  it("PLAYING + buffer-ended with preloaded inactive → PLAYING (A/B swap via HANDOFF)", () => {
    const { machine } = makeHarness();
    const item1 = makeItem("item-1");
    const item2 = makeItem("item-2");
    reachPlaying(machine, item1);
    machine.send({ type: "preload", item: item2, leadMs: 60_000 });
    machine.send({ type: "buffer-ready", bufferId: "B" });
    machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("PLAYING + offline → stays PLAYING (buffer still playing)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("PLAYING + takeover → LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "takeover", override: makeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("PLAYING + preload → PREPARING_NEXT", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "preload", item: makeItem("item-2"), leadMs: 60_000 });
    expect(machine.getSnapshot().state).toBe("PREPARING_NEXT");
    machine.destroy();
  });

  it("emits play intent with correct positionSecs on first bind", () => {
    const { machine, intents } = makeHarness();
    const now = Date.now();
    const item = makeItem("item-1", { startsAtMs: now - 600_000, endsAtMs: now + 3_000_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    const play = intents.find((i) => i.type === "play");
    expect(play?.type === "play" && play.positionSecs).toBeGreaterThan(590);
    expect(play?.type === "play" && play.positionSecs).toBeLessThan(610);
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// RECOVERING_PRIMARY state
// ---------------------------------------------------------------------------

describe("FSM matrix — RECOVERING_PRIMARY", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("RECOVERING_PRIMARY + buffer-ready → PLAYING", () => {
    const { machine } = makeHarness();
    reachRecoveringPrimary(machine);
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("RECOVERING_PRIMARY + buffer-error (with failover) → RECOVERING_FAILOVER", () => {
    const { machine } = makeHarness();
    const item = makeItem("item-1", {
      failoverSource: { kind: "mp4", url: "https://cdn.example.com/fb.mp4", expiresAtMs: null },
    });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
    machine.destroy();
  });

  it("RECOVERING_PRIMARY + buffer-stalled (with failover) → RECOVERING_FAILOVER [FIX]", () => {
    const { machine } = makeHarness();
    const item = makeItem("item-1", {
      failoverSource: { kind: "mp4", url: "https://cdn.example.com/fb.mp4", expiresAtMs: null },
    });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
    machine.destroy();
  });

  it("RECOVERING_PRIMARY + buffer-stalled (no failover) → stays RECOVERING_PRIMARY [FIX]", () => {
    const { machine } = makeHarness();
    reachRecoveringPrimary(machine);
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("RECOVERING_PRIMARY + snapshot same item → stays RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    const item = makeItem();
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("RECOVERING_PRIMARY + stall on inactive B → no state change", () => {
    const { machine } = makeHarness();
    reachRecoveringPrimary(machine);
    machine.send({ type: "buffer-stalled", bufferId: "B" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// RECOVERING_FAILOVER state
// ---------------------------------------------------------------------------

describe("FSM matrix — RECOVERING_FAILOVER", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function reachRecoveringFailover(machine: PlayerMachine): void {
    const item = makeItem("item-1", {
      failoverSource: { kind: "mp4", url: "https://cdn.example.com/fb.mp4", expiresAtMs: null },
    });
    reachPlaying(machine, item);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
  }

  it("RECOVERING_FAILOVER + buffer-ready → PLAYING", () => {
    const { machine } = makeHarness();
    reachRecoveringFailover(machine);
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("RECOVERING_FAILOVER + buffer-error → SKIP_PENDING", () => {
    const { machine } = makeHarness();
    reachRecoveringFailover(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    machine.destroy();
  });

  it("RECOVERING_FAILOVER + buffer-stalled → SKIP_PENDING [FIX]", () => {
    const { machine } = makeHarness();
    reachRecoveringFailover(machine);
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    machine.destroy();
  });

  it("RECOVERING_FAILOVER + stall on inactive B → no state change", () => {
    const { machine } = makeHarness();
    reachRecoveringFailover(machine);
    machine.send({ type: "buffer-stalled", bufferId: "B" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// SKIP_PENDING state
// ---------------------------------------------------------------------------

describe("FSM matrix — SKIP_PENDING", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function reachSkipPending(machine: PlayerMachine): void {
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
  }

  it("SKIP_PENDING + snapshot(different item) → PREPARING_ACTIVE", () => {
    const { machine } = makeHarness();
    reachSkipPending(machine);
    const item2 = makeItem("item-2");
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item2, sequence: 3 }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.destroy();
  });

  it("SKIP_PENDING + snapshot(same item, same anchor) → stays SKIP_PENDING", () => {
    const { machine } = makeHarness();
    reachSkipPending(machine);
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem(), sequence: 2 }) });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    machine.destroy();
  });

  it("SKIP_PENDING + buffer-ready → stays SKIP_PENDING (ignores ready from stale bind)", () => {
    const { machine } = makeHarness();
    reachSkipPending(machine);
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// OFFLINE_HOLD state
// ---------------------------------------------------------------------------

describe("FSM matrix — OFFLINE_HOLD", () => {
  it("OFFLINE_HOLD + online → SYNCING", () => {
    const { machine } = makeHarness();
    machine.send({ type: "offline" });
    machine.send({ type: "online" });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.destroy();
  });

  it("OFFLINE_HOLD + offline → stays OFFLINE_HOLD (idempotent)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "offline" });
    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
    machine.destroy();
  });

  it("OFFLINE_HOLD + buffer-ready → ignored (no bind pending)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "offline" });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
    machine.destroy();
  });

  it("OFFLINE_HOLD + buffer-stalled → ignored (stall guard checks state)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "offline" });
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// LIVE_OVERRIDE_ACTIVE state
// ---------------------------------------------------------------------------

describe("FSM matrix — LIVE_OVERRIDE_ACTIVE", () => {
  // NOTE: takeover() from PLAYING (where A is active) engages the INACTIVE
  // buffer B for the override and swaps it to active. So after takeover,
  // activeBufferId = "B". Buffer events must be sent to "B" to be processed.

  it("LIVE_OVERRIDE_ACTIVE + HLS stall on active B → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "takeover", override: makeOverride("hls") });
    expect(machine.getSnapshot().activeBufferId).toBe("B");
    machine.send({ type: "buffer-stalled", bufferId: "B" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("LIVE_OVERRIDE_ACTIVE + HLS stall on inactive A → stays LIVE_OVERRIDE_ACTIVE (inactive ignored)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "takeover", override: makeOverride("hls") });
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("LIVE_OVERRIDE_ACTIVE + YouTube stall on active B → stays LIVE_OVERRIDE_ACTIVE (YouTube exemption)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "takeover", override: makeOverride("youtube") });
    machine.send({ type: "buffer-stalled", bufferId: "B" });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("LIVE_OVERRIDE_ACTIVE + buffer-error on active B → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "takeover", override: makeOverride("hls") });
    machine.send({ type: "buffer-error", bufferId: "B", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// State invariant across complex event sequences
// ---------------------------------------------------------------------------

describe("FSM matrix — state invariant", () => {
  it("state is always in VALID_STATES across a 20-step event sequence", () => {
    const { machine } = makeHarness();
    const item = makeItem();
    const item2 = makeItem("item-2");

    // NOTE: after takeover from PLAYING(A active), activeBufferId becomes B.
    // Steps are structured so buffer events always go to the correct active buffer.
    const steps: Array<() => void> = [
      () => machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) }),
      () => machine.send({ type: "buffer-ready", bufferId: "A" }),
      () => machine.send({ type: "buffer-error", bufferId: "A", error: "e" }),
      () => machine.send({ type: "buffer-stalled", bufferId: "A" }),
      () => machine.send({ type: "buffer-ready", bufferId: "A" }),
      () => machine.send({ type: "offline" }),
      () => machine.send({ type: "online" }),
      () => machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 10 }) }),
      () => machine.send({ type: "buffer-ready", bufferId: "A" }),
      () => machine.send({ type: "takeover", override: makeOverride("hls") }),
      // after takeover: activeBufferId=B; stall on B escalates
      () => machine.send({ type: "buffer-stalled", bufferId: "B" }),
      () => machine.send({ type: "buffer-ready", bufferId: "B" }),
      // now in PLAYING with B active; preload A, do handoff
      () => machine.send({ type: "preload", item: item2, leadMs: 60_000 }),
      () => machine.send({ type: "buffer-ready", bufferId: "A" }),
      () => machine.send({ type: "buffer-ended", bufferId: "B" }),
      // now in PLAYING with A active; error + stall on A
      () => machine.send({ type: "buffer-error", bufferId: "A", error: "e" }),
      () => machine.send({ type: "buffer-stalled", bufferId: "A" }),
      () => machine.send({ type: "buffer-ready", bufferId: "A" }),
      () => machine.send({ type: "buffer-ended", bufferId: "A" }),
      () => machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 20 }) }),
    ];

    for (const step of steps) {
      step();
      expect(VALID_STATES.has(machine.getSnapshot().state)).toBe(true);
    }
    machine.destroy();
  });
});
