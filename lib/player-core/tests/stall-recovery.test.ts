/**
 * Stall-during-recovery tests for PlayerMachine.
 *
 * Validates that a `buffer-stalled` event received while the FSM is in
 * RECOVERING_PRIMARY or RECOVERING_FAILOVER escalates `primaryRetries`
 * and transitions correctly — rather than being silently swallowed.
 *
 * Before the fix (machine.ts onBufferStalled), RECOVERING_PRIMARY and
 * RECOVERING_FAILOVER were absent from the escalation guard so the Watchdog's
 * buffer-stalled events were silently ignored. This left clients hanging until
 * only the bind load-timeout (15 s) eventually fired.
 *
 * After the fix both states forward buffer-stalled → onBufferError so the
 * recovery chain progresses: RECOVERING_PRIMARY → RECOVERING_FAILOVER →
 * SKIP_PENDING.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine } from "../src/machine.js";
import type { AdapterIntent } from "../src/machine.js";
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
    source: { kind: "hls", url: "https://cdn.example.com/primary.m3u8", expiresAtMs: null },
    failoverSource: null,
    startsAtMs: now - 60_000,
    endsAtMs: now + 3_540_000,
    ...overrides,
  };
}

function makeItemWithFailover(): V2Item {
  return makeItem({
    failoverSource: { kind: "mp4", url: "https://cdn.example.com/failover.mp4", expiresAtMs: null },
  });
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
  const states: string[] = [];
  const machine = new PlayerMachine((intent) => intents.push(intent));
  machine.subscribe((snap) => states.push(snap.state));
  return { machine, intents, states };
}

/** Drive the machine to PLAYING (activeBufferId is always "A" at boot). */
function reachPlaying(machine: PlayerMachine, item: V2Item = makeItem()): void {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
  machine.send({ type: "buffer-ready", bufferId: "A" });
  expect(machine.getSnapshot().state).toBe("PLAYING");
}

/** Drive to RECOVERING_PRIMARY (1 buffer-error on "A"). */
function reachRecoveringPrimary(machine: PlayerMachine, item: V2Item = makeItem()): void {
  reachPlaying(machine, item);
  machine.send({ type: "buffer-error", bufferId: "A", error: "media-error" });
  expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
}

/** Drive to RECOVERING_FAILOVER (2 buffer-errors with failover source). */
function reachRecoveringFailover(machine: PlayerMachine): void {
  reachPlaying(machine, makeItemWithFailover());
  machine.send({ type: "buffer-error", bufferId: "A", error: "media-error" });
  machine.send({ type: "buffer-error", bufferId: "A", error: "media-error" });
  expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
}

// ---------------------------------------------------------------------------
// RECOVERING_PRIMARY + buffer-stalled
// ---------------------------------------------------------------------------

describe("stall-during-recovery — RECOVERING_PRIMARY", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("escalates to RECOVERING_FAILOVER when failover source is present", () => {
    const { machine, states } = makeHarness();
    reachRecoveringPrimary(machine, makeItemWithFailover());

    machine.send({ type: "buffer-stalled", bufferId: "A" });

    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
    expect(states).toContain("RECOVERING_FAILOVER");
    machine.destroy();
  });

  it("emits a bind intent during stall escalation to RECOVERING_FAILOVER", () => {
    const { machine, intents } = makeHarness();
    reachRecoveringPrimary(machine, makeItemWithFailover());
    intents.length = 0;

    machine.send({ type: "buffer-stalled", bufferId: "A" });

    const bindIntent = intents.find((i) => i.type === "bind");
    expect(bindIntent).toBeTruthy();
    machine.destroy();
  });

  it("stays RECOVERING_PRIMARY when no failover source (re-binds primary)", () => {
    const { machine, states } = makeHarness();
    reachRecoveringPrimary(machine, makeItem());

    machine.send({ type: "buffer-stalled", bufferId: "A" });

    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    expect(states.filter((s) => s === "RECOVERING_PRIMARY").length).toBeGreaterThan(0);
    machine.destroy();
  });

  it("ignores stall on inactive buffer B while active is A", () => {
    const { machine } = makeHarness();
    reachRecoveringPrimary(machine, makeItem());

    machine.send({ type: "buffer-stalled", bufferId: "B" });

    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("reaches SKIP_PENDING after two stalls with no failover source", () => {
    const { machine } = makeHarness();
    reachRecoveringPrimary(machine, makeItem());

    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    machine.destroy();
  });

  it("stall + buffer-error path each consume primaryRetries correctly", () => {
    const { machine } = makeHarness();
    reachPlaying(machine, makeItemWithFailover());

    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");

    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// RECOVERING_FAILOVER + buffer-stalled
// ---------------------------------------------------------------------------

describe("stall-during-recovery — RECOVERING_FAILOVER", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("escalates to SKIP_PENDING when failover source stalls", () => {
    const { machine, states } = makeHarness();
    reachRecoveringFailover(machine);

    machine.send({ type: "buffer-stalled", bufferId: "A" });

    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    expect(states).toContain("SKIP_PENDING");
    machine.destroy();
  });

  it("ignores stall on inactive buffer B in RECOVERING_FAILOVER", () => {
    const { machine } = makeHarness();
    reachRecoveringFailover(machine);

    machine.send({ type: "buffer-stalled", bufferId: "B" });

    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
    machine.destroy();
  });

  it("fires setNeedSnapshotCallback on SKIP_PENDING after failover stall", () => {
    const { machine } = makeHarness();
    const snapshots: unknown[] = [];
    machine.setNeedSnapshotCallback(() => snapshots.push(true));
    reachRecoveringFailover(machine);

    machine.send({ type: "buffer-stalled", bufferId: "A" });

    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    expect(snapshots.length).toBeGreaterThan(0);
    machine.destroy();
  });

  it("mixed stall + error across both recovery states reaches SKIP_PENDING", () => {
    const { machine } = makeHarness();
    reachPlaying(machine, makeItemWithFailover());

    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");

    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// LIVE_OVERRIDE_ACTIVE YouTube exemption — regression guard
// ---------------------------------------------------------------------------

describe("stall-during-recovery — LIVE_OVERRIDE_ACTIVE YouTube exemption (regression)", () => {
  it("does NOT escalate buffer-stalled for YouTube override (iframe-based, native idle)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine, makeItem());

    const override: V2Override = {
      id: "ov-yt",
      kind: "youtube",
      url: "https://youtube.com/watch?v=abc",
      title: "YouTube Live",
      startedAtMs: Date.now(),
      endsAtMs: null,
      resumeQueueOnEnd: true,
    };
    machine.send({ type: "takeover", override });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");

    machine.send({ type: "buffer-stalled", bufferId: "A" });

    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("DOES escalate buffer-stalled for HLS override on active buffer B (native video active)", () => {
    // takeover() from PLAYING (A active) puts the override on B (inactive→active).
    // So activeBufferId becomes B. Stall must be sent to B to be processed.
    const { machine } = makeHarness();
    reachPlaying(machine, makeItem());

    const override: V2Override = {
      id: "ov-hls",
      kind: "hls",
      url: "https://cdn.example.com/live.m3u8",
      title: "HLS Live Override",
      startedAtMs: Date.now(),
      endsAtMs: null,
      resumeQueueOnEnd: true,
    };
    machine.send({ type: "takeover", override });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    expect(machine.getSnapshot().activeBufferId).toBe("B");

    machine.send({ type: "buffer-stalled", bufferId: "B" });

    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Error budget resets after recovery success
// ---------------------------------------------------------------------------

describe("stall-during-recovery — error budget resets on successful play", () => {
  it("primaryRetries resets after RECOVERING_PRIMARY → PLAYING via buffer-ready", () => {
    const { machine } = makeHarness();
    reachRecoveringPrimary(machine, makeItemWithFailover());

    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");

    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");

    machine.send({ type: "buffer-error", bufferId: "A", error: "new-err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("after stall-induced SKIP_PENDING, new snapshot with different item unblocks playback", () => {
    const { machine } = makeHarness();
    reachPlaying(machine, makeItem());
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    machine.send({ type: "buffer-stalled", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    const item2 = makeItem({ id: "item-2", source: { kind: "hls", url: "https://cdn.example.com/item2.m3u8", expiresAtMs: null } });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item2, sequence: 5 }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.destroy();
  });
});
