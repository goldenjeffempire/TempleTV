/**
 * Single-item queue loop regression tests for PlayerMachine.
 *
 * Validates that the `lastEndedItemId` post-HANDOFF guard clears
 * immediately when the server advances `startsAtMs` for the same item
 * (single-item queue loop), instead of blocking rebinding for 30+ seconds.
 *
 * Regression: before the `lastEndedItemStartsAtMs` fix, a single-item queue
 * would produce a 30–90 s black-screen gap on every loop because the guard
 * matched on item ID alone — the changed `startsAtMs` was never checked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine, type AdapterIntent } from "../src/machine.js";
import type { V2Item, V2Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers (matching machine-fsm.test.ts conventions)
// ---------------------------------------------------------------------------

let _seq = 0;
function nextSeq() { return ++_seq; }

function makeItem(id: string, startsAtMs: number, durationSecs = 300): V2Item {
  return {
    id,
    title: `Item ${id}`,
    thumbnailUrl: null,
    durationSecs,
    source: { kind: "hls", url: `https://cdn.example.com/${id}.m3u8`, expiresAtMs: null },
    failoverSource: null,
    startsAtMs,
    endsAtMs: startsAtMs + durationSecs * 1_000,
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

interface Harness {
  machine: PlayerMachine;
  intents: AdapterIntent[];
  states: string[];
  naturalEndIds: string[];
}

function makeHarness(): Harness {
  const intents: AdapterIntent[] = [];
  const states: string[] = [];
  const naturalEndIds: string[] = [];

  const machine = new PlayerMachine((i) => intents.push(i));
  machine.subscribe((s) => states.push(s.state));
  machine.setNaturalEndCallback((id) => naturalEndIds.push(id));
  machine.setNeedSnapshotCallback(() => {});

  return { machine, intents, states, naturalEndIds };
}

/** Drive the machine to PLAYING with the given item on buffer A. */
function driveToPlaying(machine: PlayerMachine, item: V2Item): void {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
  machine.send({ type: "buffer-ready", bufferId: "A" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  _seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("single-item queue loop — startsAtMs fast-path", () => {
  it("clears the guard immediately when server advances startsAtMs for the same item", () => {
    const h = makeHarness();
    const now = Date.now();
    const item = makeItem("vid-1", now - 60_000, 300);

    driveToPlaying(h.machine, item);
    expect(h.machine.getSnapshot().state).toBe("PLAYING");

    // Item ends naturally with no preloaded inactive buffer → SYNCING.
    h.machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(h.machine.getSnapshot().state).toBe("SYNCING");

    // Server advances startsAtMs for the SAME item ID (new loop cycle).
    const loopItem = makeItem("vid-1", now + 200_000, 300);
    h.machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: loopItem }) });

    // Machine must immediately rebind — not stay stuck in SYNCING.
    const state = h.machine.getSnapshot().state;
    expect(state).toBe("PREPARING_ACTIVE");

    // A bind intent for the active buffer should have been emitted.
    const bindIntents = h.intents.filter((i) => i.type === "bind");
    expect(bindIntents.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT clear the guard when startsAtMs is unchanged (same cycle)", () => {
    const h = makeHarness();
    const now = Date.now();
    const item = makeItem("vid-1", now - 60_000, 300);

    driveToPlaying(h.machine, item);
    h.machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(h.machine.getSnapshot().state).toBe("SYNCING");

    // Server snapshot with the SAME startsAtMs (server hasn't advanced yet).
    h.machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });

    // Guard should still be active — machine stays in SYNCING.
    expect(h.machine.getSnapshot().state).toBe("SYNCING");
  });

  it("guard still blocks before TTL elapses (< 30 s, same anchor)", () => {
    const h = makeHarness();
    const now = Date.now();
    const item = makeItem("vid-1", now - 10_000, 600);

    driveToPlaying(h.machine, item);
    h.machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(h.machine.getSnapshot().state).toBe("SYNCING");

    vi.advanceTimersByTime(10_000);
    h.machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    expect(h.machine.getSnapshot().state).toBe("SYNCING");
  });

  it("loops 3 times without accumulating guard state (A/B preload path)", () => {
    const h = makeHarness();
    let slotStart = Date.now() - 60_000;

    const first = makeItem("vid-1", slotStart, 300);
    driveToPlaying(h.machine, first);
    expect(h.machine.getSnapshot().state).toBe("PLAYING");

    for (let i = 0; i < 3; i++) {
      const prevActive = h.machine.getSnapshot().activeBufferId;
      const inactive = prevActive === "A" ? "B" : "A";

      slotStart += 310_000;
      const loopItem = makeItem("vid-1", slotStart, 300);

      // End the active buffer — enters SYNCING (no preloaded inactive).
      h.machine.send({ type: "buffer-ended", bufferId: prevActive });
      expect(h.machine.getSnapshot().state).toBe("SYNCING");

      // New anchor for the same item — guard must clear immediately.
      h.machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: loopItem }) });
      expect(h.machine.getSnapshot().state).toBe("PREPARING_ACTIVE");

      // Simulate buffer loaded.
      const newActive = h.machine.getSnapshot().activeBufferId;
      h.machine.send({ type: "buffer-ready", bufferId: newActive });
      expect(h.machine.getSnapshot().state).toBe("PLAYING");
    }

    // All natural-end IDs should be "vid-1".
    expect(h.naturalEndIds.every((id) => id === "vid-1")).toBe(true);
    expect(h.naturalEndIds.length).toBeGreaterThanOrEqual(3);
  });

  it("guard clears for a genuinely different item (multi-item queue)", () => {
    const h = makeHarness();
    const now = Date.now();
    const itemA = makeItem("vid-a", now - 60_000, 300);
    const itemB = makeItem("vid-b", now + 250_000, 300);

    driveToPlaying(h.machine, itemA);
    h.machine.send({ type: "buffer-ended", bufferId: "A" });
    expect(h.machine.getSnapshot().state).toBe("SYNCING");

    // Server advances to a different item.
    h.machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: itemB }) });
    expect(h.machine.getSnapshot().state).toBe("PREPARING_ACTIVE");

    const bind = h.intents
      .filter((i) => i.type === "bind")
      .at(-1) as Extract<AdapterIntent, { type: "bind" }>;
    // item is V2Item — source.url contains the item id
    const bindItem = bind?.item as V2Item | undefined;
    expect(bindItem?.source?.url).toContain("vid-b");
  });

  it("TTL retry path still fires naturalEnd callback when anchor is stale", () => {
    const h = makeHarness();
    const naturalEndIds: string[] = [];
    h.machine.setNaturalEndCallback((id) => naturalEndIds.push(id));

    const now = Date.now();
    const item = makeItem("vid-1", now - 10_000, 600);

    driveToPlaying(h.machine, item);
    h.machine.send({ type: "buffer-ended", bufferId: "A" });

    const countBefore = naturalEndIds.length;

    // Advance past the 30 s TTL (same anchor — server never advanced).
    vi.advanceTimersByTime(31_000);
    h.machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });

    // Guard should have retried the naturalEnd POST.
    expect(naturalEndIds.length).toBeGreaterThan(countBefore);
    // Machine stays in SYNCING while retrying.
    expect(h.machine.getSnapshot().state).toBe("SYNCING");
  });

  it("activeBufferId stays correct after single-item loop rebind", () => {
    const h = makeHarness();
    const now = Date.now();
    const item = makeItem("vid-1", now - 60_000, 300);
    const loopItem = makeItem("vid-1", now + 200_000, 300);

    driveToPlaying(h.machine, item);
    expect(h.machine.getSnapshot().activeBufferId).toBe("A");

    h.machine.send({ type: "buffer-ended", bufferId: "A" });
    h.machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: loopItem }) });
    expect(h.machine.getSnapshot().state).toBe("PREPARING_ACTIVE");

    const newActive = h.machine.getSnapshot().activeBufferId;
    h.machine.send({ type: "buffer-ready", bufferId: newActive });
    expect(h.machine.getSnapshot().state).toBe("PLAYING");
    // Active buffer may be A or B depending on whether a preload swap occurred.
    expect(["A", "B"]).toContain(h.machine.getSnapshot().activeBufferId);
  });
});
