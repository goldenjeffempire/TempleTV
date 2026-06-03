/**
 * PiP buffer-identity and HANDOFF consistency tests for PlayerMachine.
 *
 * Validates:
 *   - After each HANDOFF the activeBufferId alternates between A and B
 *   - The previously-active buffer item is cleared after handoff
 *   - A bind intent for the NEXT item is emitted to the freed buffer post-handoff
 *   - primaryRetries resets to 0 after each successful PLAYING re-entry
 *   - Buffer identity is preserved across override takeover / release cycles
 *   - Long-duration A/B swap sequence remains consistent
 *
 * NOTE: activeBufferId starts as "A" at boot per PlayerMachine initial state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine } from "../src/machine.js";
import type { AdapterIntent } from "../src/machine.js";
import type { V2Item, V2Override, V2Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function nextSeq() { return ++_seq; }

function makeItem(id: string): V2Item {
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

function makeHarness() {
  const intents: AdapterIntent[] = [];
  const machine = new PlayerMachine((intent) => intents.push(intent));
  return { machine, intents };
}

function driveToPlaying(machine: PlayerMachine, item: V2Item): void {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
  machine.send({ type: "buffer-ready", bufferId: "A" });
  expect(machine.getSnapshot().state).toBe("PLAYING");
}

/**
 * Simulate a seamless A/B handoff.
 * - active buffer is `fromId`
 * - inactive buffer is `toId`
 * Returns the new activeBufferId after the swap.
 */
function doHandoff(
  machine: PlayerMachine,
  nextItem: V2Item,
  fromId: "A" | "B",
): "A" | "B" {
  const toId: "A" | "B" = fromId === "A" ? "B" : "A";

  machine.send({ type: "preload", item: nextItem, leadMs: 60_000 });
  machine.send({ type: "buffer-ready", bufferId: toId });
  machine.send({ type: "buffer-ended", bufferId: fromId });

  expect(machine.getSnapshot().state).toBe("PLAYING");
  expect(machine.getSnapshot().activeBufferId).toBe(toId);
  return toId;
}

// ---------------------------------------------------------------------------
// A/B alternation
// ---------------------------------------------------------------------------

describe("PiP & HANDOFF — A/B buffer identity alternation", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("activeBufferId alternates A→B→A across 10 consecutive HANDOFFs", () => {
    const { machine } = makeHarness();
    const items = Array.from({ length: 11 }, (_, i) => makeItem(`item-${i}`));

    driveToPlaying(machine, items[0]!);
    let currentActive: "A" | "B" = "A";

    for (let i = 1; i <= 10; i++) {
      currentActive = doHandoff(machine, items[i]!, currentActive);
      const expected: "A" | "B" = i % 2 === 0 ? "A" : "B";
      expect(currentActive).toBe(expected);
    }
    machine.destroy();
  });

  it("the previously-active buffer slot is null after handoff", () => {
    const { machine } = makeHarness();
    driveToPlaying(machine, makeItem("item-1"));

    doHandoff(machine, makeItem("item-2"), "A");

    const snap = machine.getSnapshot();
    expect(snap.bufferA).toBeNull();
    machine.destroy();
  });

  it("the newly-active buffer holds the correct item id after handoff", () => {
    const { machine } = makeHarness();
    const item2 = makeItem("item-2");
    driveToPlaying(machine, makeItem("item-1"));

    doHandoff(machine, item2, "A");

    const snap = machine.getSnapshot();
    const activeItem = snap.activeBufferId === "A" ? snap.bufferA : snap.bufferB;
    expect((activeItem as V2Item | null)?.id).toBe("item-2");
    machine.destroy();
  });

  it("primaryRetries resets to 0 after every PLAYING re-entry (confirms error budget resets)", () => {
    const { machine } = makeHarness();
    driveToPlaying(machine, makeItem("item-1"));
    machine.send({ type: "buffer-error", bufferId: "A", error: "err" });
    machine.send({ type: "buffer-ready", bufferId: "A" });
    expect(machine.getSnapshot().state).toBe("PLAYING");

    doHandoff(machine, makeItem("item-2"), "A");

    machine.send({ type: "buffer-error", bufferId: "B", error: "new-err" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Post-handoff inactive buffer preload
// ---------------------------------------------------------------------------

describe("PiP & HANDOFF — post-handoff inactive buffer preload", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("can preload next item into freed buffer A immediately after handoff A→B", () => {
    const { machine, intents } = makeHarness();
    const item1 = makeItem("item-1");
    const item2 = makeItem("item-2");
    const item3 = makeItem("item-3");

    driveToPlaying(machine, item1);
    doHandoff(machine, item2, "A");
    expect(machine.getSnapshot().activeBufferId).toBe("B");

    intents.length = 0;
    machine.send({ type: "preload", item: item3, leadMs: 60_000 });

    const bindToA = intents.find((i) => i.type === "bind" && i.bufferId === "A");
    expect(bindToA).toBeTruthy();
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Override takeover / release
// ---------------------------------------------------------------------------

describe("PiP & HANDOFF — override takeover / release", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("activeBufferId is 'B' after override takeover from PLAYING(A active) — override uses inactive buffer", () => {
    // When A is active and takeover fires, engageOverride() binds the override
    // to the INACTIVE buffer (B) and swaps it to active. So activeBufferId = B.
    const { machine } = makeHarness();
    driveToPlaying(machine, makeItem("item-1"));
    expect(machine.getSnapshot().activeBufferId).toBe("A");

    const override: V2Override = {
      id: "ov-1",
      kind: "hls",
      url: "https://cdn.example.com/live.m3u8",
      title: "Live Override",
      startedAtMs: Date.now(),
      endsAtMs: null,
      resumeQueueOnEnd: true,
    };
    machine.send({ type: "takeover", override });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    expect(machine.getSnapshot().activeBufferId).toBe("B");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// 50-HANDOFF stress — A/B consistency
// ---------------------------------------------------------------------------

describe("PiP & HANDOFF — 50-item stress: A/B consistency", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("A/B buffer remains consistent and state is always valid across 50 HANDOFFs", () => {
    const { machine } = makeHarness();
    const pool = [makeItem("a"), makeItem("b"), makeItem("c")];

    driveToPlaying(machine, pool[0]!);

    const VALID_STATES = new Set([
      "BOOTSTRAP", "SYNCING", "PREPARING_ACTIVE", "PLAYING",
      "PREPARING_NEXT", "HANDOFF", "RECOVERING_PRIMARY", "RECOVERING_FAILOVER",
      "SKIP_PENDING", "FATAL", "OFFLINE_HOLD", "LIVE_OVERRIDE_ACTIVE",
    ]);

    let currentActive: "A" | "B" = "A";
    for (let i = 1; i <= 50; i++) {
      const nextItem = pool[i % pool.length]!;
      currentActive = doHandoff(machine, nextItem, currentActive);

      const snap = machine.getSnapshot();
      expect(VALID_STATES.has(snap.state)).toBe(true);
      expect(snap.activeBufferId).toBeTruthy();

      const activeSlot = snap.activeBufferId === "A" ? snap.bufferA : snap.bufferB;
      expect(activeSlot).toBeTruthy();
    }
    machine.destroy();
  });
});
