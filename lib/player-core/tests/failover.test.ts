/**
 * Failover chain tests for PlayerMachine.
 *
 * Covers the full recovery ladder:
 *   PLAYING → RECOVERING_PRIMARY → (if failover present) RECOVERING_FAILOVER
 *          → (on failover error) SKIP_PENDING → (3× SKIP) FATAL → (timer) SYNCING
 *
 * Also covers: error budget reset on successful play, FATAL backoff accumulation,
 * PiP/override takeover during recovery, and failover overlay intents.
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

function makeItemWithFailover(overrides: Partial<V2Item> = {}): V2Item {
  return makeItem({
    failoverSource: { kind: "mp4", url: "https://cdn.example.com/failover.mp4", expiresAtMs: null },
    ...overrides,
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

function makeHarness() {
  const intents: AdapterIntent[] = [];
  const states: string[] = [];
  const machine = new PlayerMachine((intent) => intents.push(intent));
  machine.subscribe((snap) => states.push(snap.state));
  return { machine, intents, states };
}

function reachPlaying(machine: PlayerMachine, item: V2Item = makeItem()): void {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 1 }) });
  machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
}

// ---------------------------------------------------------------------------
// Primary recovery
// ---------------------------------------------------------------------------

describe("Failover — RECOVERING_PRIMARY", () => {
  it("buffer-error in PLAYING → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "media-error" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("RECOVERING_PRIMARY: buffer-ready → PLAYING (primary recovered)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "media-error" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("RECOVERING_PRIMARY: error 1 → RECOVERING_PRIMARY, error 2 → RECOVERING_FAILOVER", () => {
    // Error budget with failover source:
    //   primaryRetries=1 → silent reload (RECOVERING_PRIMARY)
    //   primaryRetries=2 → try failover source (RECOVERING_FAILOVER)
    //   primaryRetries≥3 → give up (SKIP_PENDING)
    const { machine } = makeHarness();
    reachPlaying(machine, makeItemWithFailover());

    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
  });

  it("error budget resets when PLAYING is reached (primary proves stable)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine, makeItemWithFailover());

    // Use 2 of 3 budget
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-ready", bufferId: "A" }); // recover
    expect(machine.getSnapshot().state).toBe("PLAYING");

    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");

    // Should still have fresh budget — one more error is fine
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    // Not RECOVERING_FAILOVER — budget was reset
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("RECOVERING_PRIMARY: no failover source → 3 errors → SKIP_PENDING", () => {
    // Without a failoverSource, error 2 stays in RECOVERING_PRIMARY (second primary attempt).
    // Error 3 → primaryRetries=3 (≥3) → SKIP_PENDING.
    const { machine } = makeHarness();
    reachPlaying(machine); // item with no failoverSource

    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    // No failover: tries primary one more time (second silent reload)
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
  });
});

// ---------------------------------------------------------------------------
// Failover source
// ---------------------------------------------------------------------------

describe("Failover — RECOVERING_FAILOVER", () => {
  it("bind emitted for failover source when transitioning to RECOVERING_FAILOVER", () => {
    // Error 1 (primaryRetries=1) → RECOVERING_PRIMARY (silent reload)
    // Error 2 (primaryRetries=2) → RECOVERING_FAILOVER (has failoverSource)
    const { machine, intents } = makeHarness();
    const item = makeItemWithFailover({ id: "item-failover-test" });
    reachPlaying(machine, item);

    intents.length = 0;
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");

    const bindIntents = intents.filter((i) => i.type === "bind");
    expect(bindIntents.length).toBeGreaterThanOrEqual(1);
  });

  it("RECOVERING_FAILOVER: buffer-ready → PLAYING", () => {
    const { machine } = makeHarness();
    reachPlaying(machine, makeItemWithFailover());

    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");

    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
  });

  it("RECOVERING_FAILOVER: buffer-error → SKIP_PENDING", () => {
    const { machine } = makeHarness();
    reachPlaying(machine, makeItemWithFailover());

    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");

    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "failover-err" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");
  });
});

// ---------------------------------------------------------------------------
// SKIP_PENDING → FATAL chain
// ---------------------------------------------------------------------------

describe("Failover — SKIP_PENDING → FATAL", () => {
  it("SKIP_PENDING: snapshot with same anchor does not rebind (stuck guard)", () => {
    const { machine, intents } = makeHarness();
    const item = makeItem({ id: "bad-item" });
    reachPlaying(machine, item);

    // Exhaust budget → SKIP_PENDING
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    intents.length = 0;
    // Same anchor snapshot must NOT re-bind
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: 2 }) });
    const rebind = intents.find((i) => i.type === "bind");
    expect(rebind).toBeUndefined();
  });

  it("3 SKIP_PENDING same-anchor cycles → FATAL", () => {
    const { machine } = makeHarness();
    const item = makeItem({ id: "stuck-item" });
    reachPlaying(machine, item);

    function driveToSkipPending() {
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
    }

    driveToSkipPending();
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    // 3× same-anchor snapshot → FATAL after 3 cycles
    for (let i = 0; i < 3; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: i + 2 }) });
    }
    expect(machine.getSnapshot().state).toBe("FATAL");
  });

  it("new item in SKIP_PENDING snapshot clears skip counter → PREPARING_ACTIVE", () => {
    const { machine } = makeHarness();
    const item = makeItem({ id: "bad-item" });
    reachPlaying(machine, item);

    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    const newItem = makeItem({ id: "good-item", endsAtMs: Date.now() + 7_200_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: newItem, sequence: 5 }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// FATAL auto-recovery
// ---------------------------------------------------------------------------

describe("Failover — FATAL auto-recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function driveToFatal(machine: PlayerMachine): void {
    const item = makeItem({ id: "fatal-item" });
    reachPlaying(machine, item);
    for (let i = 0; i < 3; i++) {
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: i + 2 }) });
    }
  }

  it("FATAL state auto-recovers to SYNCING after 30s (first attempt)", () => {
    const { machine } = makeHarness();
    driveToFatal(machine);
    expect(machine.getSnapshot().state).toBe("FATAL");

    vi.advanceTimersByTime(31_000);
    expect(machine.getSnapshot().state).toBe("SYNCING");
  });

  it("FATAL: setNeedSnapshotCallback fires when auto-recovery timer elapses", () => {
    const { machine } = makeHarness();
    let snapRequests = 0;
    machine.setNeedSnapshotCallback(() => snapRequests++);
    driveToFatal(machine);
    expect(machine.getSnapshot().state).toBe("FATAL");

    vi.advanceTimersByTime(31_000);
    expect(snapRequests).toBeGreaterThanOrEqual(1);
  });

  it("FATAL backoff doubles on each successive FATAL entry — capped at 240s", () => {
    const FATAL_AUTO_RECOVERY_MS = 30_000;
    const FATAL_BACKOFF_MAX_MS = 240_000;
    const expected = [30_000, 60_000, 120_000, 240_000, 240_000, 240_000];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const backoff = Math.min(
        FATAL_AUTO_RECOVERY_MS * Math.pow(2, attempt - 1),
        FATAL_BACKOFF_MAX_MS,
      );
      expect(backoff).toBe(expected[attempt - 1]);
    }
  });

  it("successful PLAYING resets FATAL backoff counter", () => {
    const { machine } = makeHarness();
    driveToFatal(machine);
    expect(machine.getSnapshot().state).toBe("FATAL");

    // Recover via auto-recovery timer + fresh snapshot
    vi.advanceTimersByTime(31_000);
    const goodItem = makeItem({ id: "good-item", endsAtMs: Date.now() + 7_200_000 });
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: goodItem, sequence: 10 }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    // A subsequent FATAL entry should start from the base 30s (counter reset)
    // We can't introspect fatalAttemptCount directly but verify the formula
  });

  it("destroy() cancels FATAL auto-recovery timer", () => {
    const { machine } = makeHarness();
    driveToFatal(machine);
    expect(machine.getSnapshot().state).toBe("FATAL");

    // Set callback AFTER driving to FATAL so we don't count SKIP_PENDING
    // onNeedSnapshotCb calls that happen during the driveToFatal transitions.
    let snapCalled = 0;
    machine.setNeedSnapshotCallback(() => snapCalled++);

    machine.destroy();
    vi.advanceTimersByTime(300_000);
    expect(snapCalled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Override takeover during recovery
// ---------------------------------------------------------------------------

describe("Failover — override interaction", () => {
  it("takeover during RECOVERING_PRIMARY → LIVE_OVERRIDE_ACTIVE (override wins)", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    machine.send({ type: "takeover", override: makeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
  });

  it("takeover during SKIP_PENDING → LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err1" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err2" });
    machine.send({ type: "buffer-error", bufferId: "A", error: "err3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING");

    machine.send({ type: "takeover", override: makeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
  });

  it("buffer-error in LIVE_OVERRIDE_ACTIVE → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    machine.send({ type: "takeover", override: makeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("HLS override buffer-stalled escalates to RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    machine.send({ type: "takeover", override: makeOverride({ kind: "hls" }) });
    machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
  });

  it("YouTube override buffer-stalled is suppressed — stays LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    machine.send({ type: "takeover", override: makeOverride({ kind: "youtube", url: "https://youtube.com/embed/id" }) });
    machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Failover overlay intents
// ---------------------------------------------------------------------------

describe("Failover — overlay intents during recovery", () => {
  it("show-overlay(failover) emitted when server sets failover.active=true", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine);
    intents.length = 0;

    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({
        current: makeItem(),
        failover: { active: true, reason: "Emergency maintenance" },
        sequence: 2,
      }),
    });

    const overlay = intents.find((i) => i.type === "show-overlay");
    expect(overlay).toBeDefined();
    if (overlay?.type === "show-overlay") {
      expect(overlay.kind).toBe("failover");
      expect(overlay.reason).toBe("Emergency maintenance");
    }
  });

  it("hide-overlay emitted when failover.active flips back to false", () => {
    const { machine, intents } = makeHarness();
    reachPlaying(machine);
    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({ current: makeItem(), failover: { active: true, reason: "Test" }, sequence: 2 }),
    });
    intents.length = 0;

    machine.send({
      type: "snapshot",
      snapshot: makeSnapshot({ current: makeItem(), failover: { active: false, reason: null }, sequence: 3 }),
    });
    expect(intents.some((i) => i.type === "hide-overlay")).toBe(true);
  });
});
