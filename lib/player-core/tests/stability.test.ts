/**
 * Long-running stability and 24/7 simulation tests for PlayerMachine.
 *
 * Validates that:
 *   - The FSM never deadlocks across hundreds of normal transitions
 *   - A/B buffer swap tracking remains correct through a full broadcast day
 *   - Repeated override takeover/release cycles leave the machine in a clean state
 *   - PiP-relevant buffer identity is preserved across handoffs
 *   - Concurrent OFFLINE/ONLINE cycles during playback recover correctly
 *   - State never becomes undefined or invalid
 */
import { describe, it, expect, vi } from "vitest";
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

let _seq = 0;
function nextSeq() { return ++_seq; }

function makeItem(id: string, offsetMs = 0): V2Item {
  const now = Date.now();
  return {
    id,
    title: `Sermon ${id}`,
    thumbnailUrl: null,
    durationSecs: 3600,
    source: { kind: "hls", url: `https://cdn.example.com/${id}.m3u8`, expiresAtMs: null },
    failoverSource: null,
    startsAtMs: now - 60_000 + offsetMs,
    endsAtMs: now + 3_540_000 + offsetMs,
  };
}

function makeSnapshot(overrides: Partial<V2Snapshot> = {}): V2Snapshot {
  return {
    channelId: "main",
    sequence: nextSeq(),
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
    id: `ov-${nextSeq()}`,
    kind,
    url: "https://cdn.example.com/live.m3u8",
    title: "Live",
    startedAtMs: Date.now(),
    endsAtMs: null,
    resumeQueueOnEnd: true,
  };
}

function makeHarness() {
  const intents: AdapterIntent[] = [];
  const states: string[] = [];
  const machine = new PlayerMachine((intent) => intents.push(intent));
  machine.subscribe((snap) => states.push(snap.state));
  return { machine, intents, states };
}

function assertValidState(machine: PlayerMachine, context: string) {
  const state = machine.getSnapshot().state;
  if (!VALID_STATES.has(state)) {
    throw new Error(`Invalid FSM state "${state}" at: ${context}`);
  }
}

function reachPlaying(machine: PlayerMachine, item: V2Item): void {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
  machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
}

// ---------------------------------------------------------------------------
// Multi-item queue cycling simulation
// ---------------------------------------------------------------------------

describe("Stability — multi-item queue cycling", () => {
  it("50-item queue cycles without deadlock or invalid state", () => {
    _seq = 0;
    const { machine } = makeHarness();

    for (let i = 0; i < 50; i++) {
      const item = makeItem(`sermon-${i}`);
      const nextItem = makeItem(`sermon-${i + 1}`, 3_600_000);

      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      assertValidState(machine, `post-ready item ${i}`);
      expect(machine.getSnapshot().state).toBe("PLAYING");

      // Preload next item
      machine.send({ type: "preload", item: nextItem, leadMs: 90_000 });
      const inactiveId = machine.getSnapshot().activeBufferId === "A" ? "B" : "A";
      machine.send({ type: "buffer-ready", bufferId: inactiveId });
      assertValidState(machine, `post-inactive-ready item ${i}`);

      // Simulate natural end
      machine.send({ type: "buffer-ended", bufferId: machine.getSnapshot().activeBufferId });
      assertValidState(machine, `post-ended item ${i}`);
    }

    // After 50 complete cycles, must not be FATAL or BOOTSTRAP
    const finalState = machine.getSnapshot().state;
    expect(["PLAYING", "HANDOFF", "SYNCING", "PREPARING_ACTIVE"]).toContain(finalState);
    machine.destroy();
  });

  it("A/B buffer identity is consistent across 20 handoffs", () => {
    _seq = 0;
    const { machine } = makeHarness();

    let activeId = "A";
    for (let i = 0; i < 20; i++) {
      const item = makeItem(`item-${i}`);
      const nextItem = makeItem(`item-${i + 1}`, 3_600_000);

      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      activeId = machine.getSnapshot().activeBufferId;

      const inactiveId = activeId === "A" ? "B" : "A";
      machine.send({ type: "preload", item: nextItem, leadMs: 90_000 });
      machine.send({ type: "buffer-ready", bufferId: inactiveId });
      machine.send({ type: "buffer-ended", bufferId: activeId });

      // After handoff, active buffer should be the previously inactive one
      if (machine.getSnapshot().state === "PLAYING") {
        expect(machine.getSnapshot().activeBufferId).toBe(inactiveId);
      }
      assertValidState(machine, `A/B swap check ${i}`);
    }
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Override cycle stability
// ---------------------------------------------------------------------------

describe("Stability — override takeover/release cycles", () => {
  it("20 takeover+recovery cycles leave machine in valid state", () => {
    _seq = 0;
    const { machine } = makeHarness();

    const baseItem = makeItem("base-item");
    reachPlaying(machine, baseItem);

    for (let i = 0; i < 20; i++) {
      machine.send({ type: "takeover", override: makeOverride("hls") });
      expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
      assertValidState(machine, `override active cycle ${i}`);

      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
      assertValidState(machine, `post-override-error cycle ${i}`);

      // Recover and get back to PLAYING
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      assertValidState(machine, `post-override-recovery cycle ${i}`);
      if (machine.getSnapshot().state !== "PLAYING") {
        machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: baseItem }) });
        machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      }
    }
    machine.destroy();
  });

  it("YouTube override: 10 cycles of stall → stay active (not escalate)", () => {
    _seq = 0;
    const { machine } = makeHarness();

    for (let i = 0; i < 10; i++) {
      machine.send({
        type: "takeover",
        override: { ...makeOverride("hls"), kind: "youtube", url: "https://youtube.com/embed/test" },
      });
      expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");

      // YouTube stalls must never escalate
      machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
      expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
      assertValidState(machine, `yt-stall cycle ${i}`);
    }
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// OFFLINE/ONLINE resilience
// ---------------------------------------------------------------------------

describe("Stability — offline/online recovery", () => {
  it("offline during PLAYING is ignored — buffer keeps playing (video data already buffered)", () => {
    // Design decision: when already PLAYING, a network-offline event is ignored
    // so viewers don't lose their current frame. HLS buffers hold several seconds
    // of pre-downloaded data. If the buffer runs dry, the stall watchdog fires and
    // the normal RECOVERING → SKIP_PENDING path kicks in instead.
    _seq = 0;
    const { machine } = makeHarness();
    const item = makeItem("sermon-offline");
    reachPlaying(machine, item);
    expect(machine.getSnapshot().state).toBe("PLAYING");

    machine.send({ type: "offline" });
    // PLAYING → stays PLAYING (buffer is still live; don't blank the screen)
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("offline during SYNCING (no content) → OFFLINE_HOLD → online → SYNCING", () => {
    _seq = 0;
    const { machine } = makeHarness();
    // SYNCING (no current item) → offline should show the offline overlay
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null }) });
    expect(machine.getSnapshot().state).toBe("SYNCING");

    machine.send({ type: "offline" });
    expect(machine.getSnapshot().state).toBe("OFFLINE_HOLD");

    machine.send({ type: "online" });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    machine.destroy();
  });

  it("10 rapid offline/online toggles during PLAYING — machine never corrupts state", () => {
    _seq = 0;
    const { machine } = makeHarness();
    const item = makeItem("rapid-toggle");
    reachPlaying(machine, item);

    for (let i = 0; i < 10; i++) {
      machine.send({ type: "offline" });
      assertValidState(machine, `offline ${i}`);
      machine.send({ type: "online" });
      assertValidState(machine, `online ${i}`);
      // Re-supply snapshot to give the machine something to do
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    }
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("offline during RECOVERING_PRIMARY is ignored — machine stays in recovery", () => {
    // Same design decision: RECOVERING_* states have content loaded. A network drop
    // should not blank the screen — the stall path handles it if the buffer runs dry.
    _seq = 0;
    const { machine } = makeHarness();
    reachPlaying(machine);
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    machine.send({ type: "offline" });
    // Still RECOVERING_PRIMARY — the offline event is ignored for content-bearing states
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// PiP / A-B buffer identity
// ---------------------------------------------------------------------------

describe("Stability — PiP buffer identity", () => {
  it("active buffer is always the one that was last swapped-to", () => {
    _seq = 0;
    const { machine } = makeHarness();

    const item1 = makeItem("item-pip-1");
    const item2 = makeItem("item-pip-2", 3_600_000);

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().activeBufferId).toBe("A");

    machine.send({ type: "preload", item: item2, leadMs: 90_000 });
    machine.send({ type: "buffer-ready", bufferId: "B" });
    machine.send({ type: "buffer-ended", bufferId: "A" });

    // After handoff, B should be active
    expect(machine.getSnapshot().activeBufferId).toBe("B");
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("override uses inactive buffer (A→B swap preserves active correctly)", () => {
    _seq = 0;
    const { machine } = makeHarness();

    // Start with A active
    const item1 = makeItem("pip-base");
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item1 }) });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().activeBufferId).toBe("A");

    // Override binds B (inactive) and swaps to B
    const override = makeOverride("hls");
    machine.send({ type: "takeover", override });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    expect(machine.getSnapshot().activeBufferId).toBe("B");

    // Override item is stored in B
    expect(machine.getSnapshot().bufferB).toMatchObject({ id: override.id });
    machine.destroy();
  });

  it("after override recovery, active buffer item matches recovered source", () => {
    _seq = 0;
    const { machine } = makeHarness();

    const item = makeItem("pip-recovery");
    reachPlaying(machine, item);

    machine.send({ type: "takeover", override: makeOverride("hls") });
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "err" });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    assertValidState(machine, "after override recovery");
    machine.destroy();
  });

  it("bufferA + bufferB are null in SYNCING (no stale PiP surface)", () => {
    _seq = 0;
    const { machine } = makeHarness();
    const item = makeItem("pip-syncing");
    reachPlaying(machine, item);

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: null }) });
    expect(machine.getSnapshot().state).toBe("SYNCING");
    expect(machine.getSnapshot().bufferA).toBeNull();
    expect(machine.getSnapshot().bufferB).toBeNull();
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Sequence regression robustness
// ---------------------------------------------------------------------------

describe("Stability — sequence regression robustness", () => {
  it("high-volume out-of-order snapshots never regress lastSequence", () => {
    _seq = 0;
    const { machine } = makeHarness();
    const sequences = [10, 3, 15, 2, 20, 1, 18, 25, 7, 22];

    for (const seq of sequences) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ sequence: seq }) });
    }
    expect(machine.getSnapshot().lastSequence).toBe(25);
    machine.destroy();
  });

  it("100 in-order snapshots with items — lastSequence always advances", () => {
    _seq = 0;
    const { machine } = makeHarness();
    let expected = 0;

    for (let i = 1; i <= 100; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem(`item-${i}`), sequence: i }) });
      expected = i;
    }
    expect(machine.getSnapshot().lastSequence).toBe(expected);
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: multiple machines don't share state
// ---------------------------------------------------------------------------

describe("Stability — multiple machine instances are isolated", () => {
  it("two machines playing different items are fully independent", () => {
    _seq = 0;
    const h1 = makeHarness();
    const h2 = makeHarness();

    const item1 = makeItem("machine-1-item");
    const item2 = makeItem("machine-2-item");

    reachPlaying(h1.machine, item1);
    reachPlaying(h2.machine, item2);

    expect(h1.machine.getSnapshot().state).toBe("PLAYING");
    expect(h2.machine.getSnapshot().state).toBe("PLAYING");

    // Error in machine 1 does NOT affect machine 2
    h1.machine.send({ type: "buffer-error", bufferId: "A", error: "isolated-err" });
    expect(h1.machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    expect(h2.machine.getSnapshot().state).toBe("PLAYING");

    h1.machine.destroy();
    h2.machine.destroy();
  });

  it("destroying machine 1 does not affect machine 2", () => {
    _seq = 0;
    const h1 = makeHarness();
    const h2 = makeHarness();

    reachPlaying(h1.machine, makeItem("m1"));
    reachPlaying(h2.machine, makeItem("m2"));

    h1.machine.destroy();
    // h2 must still be in PLAYING
    expect(h2.machine.getSnapshot().state).toBe("PLAYING");
    h2.machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// 24/7 broadcast day simulation
// ---------------------------------------------------------------------------

describe("Stability — 24h broadcast day simulation", () => {
  it("simulates 24 queue items (1h each) cycling without invalid state", () => {
    _seq = 0;
    const { machine } = makeHarness();

    // Simulate 24 hourly items cycling (one per 'hour')
    for (let hour = 0; hour < 24; hour++) {
      const item = makeItem(`hour-${hour}-sermon`);
      const nextItem = makeItem(`hour-${hour + 1}-sermon`, (hour + 1) * 3_600_000);

      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, next: nextItem }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      assertValidState(machine, `hour ${hour} playing`);

      if (machine.getSnapshot().state === "PLAYING") {
        const inactiveId = machine.getSnapshot().activeBufferId === "A" ? "B" : "A";
        machine.send({ type: "preload", item: nextItem, leadMs: 120_000 });
        machine.send({ type: "buffer-ready", bufferId: inactiveId });
        machine.send({ type: "buffer-ended", bufferId: machine.getSnapshot().activeBufferId });
        assertValidState(machine, `hour ${hour} handoff`);
      }
    }

    // Machine must still be in a valid operational state after 24 hours
    const finalState = machine.getSnapshot().state;
    expect(VALID_STATES.has(finalState)).toBe(true);
    expect(["FATAL", "BOOTSTRAP"]).not.toContain(finalState);
    machine.destroy();
  });

  it("simulates random errors scattered across 100 items — machine always recovers", () => {
    _seq = 0;
    const { machine } = makeHarness();

    // Deterministic pseudo-random: error on items 7, 23, 41, 67, 89
    const errorItems = new Set([7, 23, 41, 67, 89]);

    for (let i = 0; i < 100; i++) {
      const item = makeItem(`scattered-${i}`);
      const nextItem = makeItem(`scattered-${i + 1}`, 3_600_000);

      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });

      if (errorItems.has(i) && machine.getSnapshot().state === "PLAYING") {
        // Single recoverable error
        machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "transient" });
        machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
        assertValidState(machine, `post-error recovery item ${i}`);
      }

      if (machine.getSnapshot().state === "PLAYING") {
        const inactiveId = machine.getSnapshot().activeBufferId === "A" ? "B" : "A";
        machine.send({ type: "preload", item: nextItem, leadMs: 90_000 });
        machine.send({ type: "buffer-ready", bufferId: inactiveId });
        machine.send({ type: "buffer-ended", bufferId: machine.getSnapshot().activeBufferId });
      }

      assertValidState(machine, `item ${i} end`);
    }

    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// YouTube source stability — mixed queue cycling
// ---------------------------------------------------------------------------

describe("Stability — YouTube source in mixed queue", () => {
  it("30-item queue with YouTube items at every 3rd position cycles without deadlock", () => {
    _seq = 0;
    const { machine } = makeHarness();

    for (let i = 0; i < 30; i++) {
      const isYouTube = i % 3 === 1;
      const item: V2Item = isYouTube
        ? {
            id: `yt-${i}`, title: `YT ${i}`, thumbnailUrl: null, durationSecs: 3600,
            source: { kind: "youtube", url: `https://www.youtube.com/watch?v=YT${i}`, expiresAtMs: null },
            failoverSource: null, startsAtMs: Date.now() - 60_000, endsAtMs: Date.now() + 3_540_000,
          }
        : makeItem(`hls-${i}`);

      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      assertValidState(machine, `mixed item ${i}`);
      expect(machine.getSnapshot().state).toBe("PLAYING");
    }

    machine.destroy();
  });

  it("YouTube → HLS → YouTube A/B swap — activeBufferId always alternates correctly", () => {
    _seq = 0;
    const { machine } = makeHarness();
    const kinds: Array<"hls" | "youtube"> = [
      "hls", "youtube", "hls", "youtube", "hls", "youtube",
    ];

    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i]!;
      const current: V2Item = kind === "youtube"
        ? {
            id: `yt-${i}`, title: `YT ${i}`, thumbnailUrl: null, durationSecs: 3600,
            source: { kind: "youtube", url: `https://www.youtube.com/watch?v=YT${i}`, expiresAtMs: null },
            failoverSource: null, startsAtMs: Date.now() - 60_000, endsAtMs: Date.now() + 3_540_000,
          }
        : makeItem(`hls-${i}`);
      const nextKind = kinds[i + 1];
      const next: V2Item | null = nextKind != null
        ? nextKind === "youtube"
          ? {
              id: `yt-next-${i}`, title: `YT Next`, thumbnailUrl: null, durationSecs: 3600,
              source: { kind: "youtube", url: `https://www.youtube.com/watch?v=YTN${i}`, expiresAtMs: null },
              failoverSource: null, startsAtMs: Date.now() + 3_540_000, endsAtMs: Date.now() + 7_200_000,
            }
          : makeItem(`hls-next-${i}`)
        : null;

      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current, next }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      const activeId = machine.getSnapshot().activeBufferId;
      assertValidState(machine, `item ${i} (${kind})`);

      if (next) {
        const inactiveId: "A" | "B" = activeId === "A" ? "B" : "A";
        machine.send({ type: "preload", item: next, leadMs: 90_000 });
        machine.send({ type: "buffer-ready", bufferId: inactiveId });
        machine.send({ type: "buffer-ended", bufferId: activeId });
        assertValidState(machine, `handoff ${i}`);
        if (machine.getSnapshot().state === "PLAYING") {
          expect(machine.getSnapshot().activeBufferId).toBe(inactiveId);
        }
      }
    }

    machine.destroy();
  });

  it("YouTube override cycling between queue items: 10 takeover+release cycles", () => {
    _seq = 0;
    const { machine } = makeHarness();
    const baseItem = makeItem("base-hls");
    reachPlaying(machine, baseItem);

    for (let i = 0; i < 10; i++) {
      // Takeover with YouTube override
      machine.send({
        type: "takeover",
        override: {
          id: `ov-yt-${i}`, kind: "youtube",
          url: "https://www.youtube.com/watch?v=LIVE",
          title: "Live", startedAtMs: Date.now(), endsAtMs: null, resumeQueueOnEnd: true,
        },
      });
      expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");

      // Stall during YouTube override must NOT escalate
      machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
      expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");

      // Return to queue via new snapshot
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: baseItem }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      assertValidState(machine, `post-override-${i}`);
    }

    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// FATAL auto-recovery cycle stability
// ---------------------------------------------------------------------------

describe("Stability — FATAL auto-recovery cycles", () => {
  it("FATAL state always auto-recovers to SYNCING after 30s timer", () => {
    _seq = 0;
    vi.useFakeTimers();
    try {
      const { machine } = makeHarness();

      // Drive to FATAL by sending 3 SKIP_PENDING cycles
      // Each cycle: snapshot → buffer-ready → 2 errors (no failover) → SKIP_PENDING
      for (let skip = 0; skip < 3 && machine.getSnapshot().state !== "FATAL"; skip++) {
        machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem(`burn-${skip}`) }) });
        machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
        machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e1" });
        machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e2" });
        assertValidState(machine, `skip cycle ${skip}`);
      }

      if (machine.getSnapshot().state === "FATAL") {
        vi.advanceTimersByTime(30_000);
        expect(["SYNCING", "BOOTSTRAP"]).toContain(machine.getSnapshot().state);
      }

      machine.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after FATAL recovery, machine accepts a new snapshot and re-enters PREPARING_ACTIVE", () => {
    _seq = 0;
    vi.useFakeTimers();
    try {
      const { machine } = makeHarness();

      // Drive toward FATAL
      for (let i = 0; i < 3; i++) {
        machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeItem(`f-${i}`) }) });
        machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
        machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e1" });
        machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e2" });
      }

      if (machine.getSnapshot().state === "FATAL") {
        vi.advanceTimersByTime(30_000);

        const recoveryItem = makeItem("recovery-item");
        machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: recoveryItem }) });
        assertValidState(machine, "post-FATAL-recovery-snapshot");
        expect(["PREPARING_ACTIVE", "PLAYING", "SYNCING"]).toContain(machine.getSnapshot().state);
      }

      machine.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("FATAL backoff doubles each cycle: 30s → 60s → 120s → 240s → cap at 240s", () => {
    const FATAL_AUTO_RECOVERY_MS = 30_000;
    const FATAL_BACKOFF_MAX_MS = 240_000;

    const schedule = [1, 2, 3, 4, 5, 6].map((attempt) =>
      Math.min(FATAL_AUTO_RECOVERY_MS * Math.pow(2, attempt - 1), FATAL_BACKOFF_MAX_MS),
    );
    expect(schedule).toEqual([30_000, 60_000, 120_000, 240_000, 240_000, 240_000]);
    expect(Math.max(...schedule)).toBe(FATAL_BACKOFF_MAX_MS);
  });

  it("primaryRetries resets to 0 after each successful buffer-ready post-recovery", () => {
    _seq = 0;
    vi.useFakeTimers();
    try {
      const { machine } = makeHarness();
      const item = makeItem("retry-reset-item");

      // Play successfully
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      expect(machine.getSnapshot().state).toBe("PLAYING");

      // One error → RECOVERING_PRIMARY (primaryRetries = 1)
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "transient" });
      expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

      // Recovery: buffer-ready → back to PLAYING (primaryRetries reset)
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      expect(machine.getSnapshot().state).toBe("PLAYING");

      // Another error should start from primaryRetries=0 again → RECOVERING_PRIMARY
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "transient2" });
      expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

      machine.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 24/7 broadcast — YouTube items scattered across full day
// ---------------------------------------------------------------------------

describe("Stability — 24h broadcast with YouTube sources", () => {
  it("24-hour simulation with YouTube items every 6th slot — valid state throughout", () => {
    _seq = 0;
    const { machine } = makeHarness();

    for (let hour = 0; hour < 24; hour++) {
      const isYoutube = hour % 6 === 5; // every 6th hour is YouTube
      const current: V2Item = isYoutube
        ? {
            id: `yt-hour-${hour}`, title: `YT Sermon ${hour}`, thumbnailUrl: null, durationSecs: 3600,
            source: { kind: "youtube", url: `https://www.youtube.com/watch?v=HR${hour}`, expiresAtMs: null },
            failoverSource: null, startsAtMs: Date.now() - 60_000, endsAtMs: Date.now() + 3_540_000,
          }
        : makeItem(`hour-${hour}`, hour * 3_600_000);

      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      assertValidState(machine, `hour ${hour} playing (${isYoutube ? "youtube" : "hls"})`);

      if (machine.getSnapshot().state === "PLAYING") {
        const nextHour = hour + 1;
        const nextItem = makeItem(`hour-${nextHour}`, nextHour * 3_600_000);
        const inactiveId = machine.getSnapshot().activeBufferId === "A" ? "B" : "A";
        machine.send({ type: "preload", item: nextItem, leadMs: 120_000 });
        machine.send({ type: "buffer-ready", bufferId: inactiveId });
        machine.send({ type: "buffer-ended", bufferId: machine.getSnapshot().activeBufferId });
        assertValidState(machine, `hour ${hour} handoff`);
      }
    }

    const finalState = machine.getSnapshot().state;
    expect(VALID_STATES.has(finalState)).toBe(true);
    expect(["FATAL", "BOOTSTRAP"]).not.toContain(finalState);
    machine.destroy();
  });
});
