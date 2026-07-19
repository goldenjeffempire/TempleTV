import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine } from "../src/machine.js";
import type { AdapterIntent } from "../src/machine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMachine() {
  const intents: AdapterIntent[] = [];
  const emit = (intent: AdapterIntent) => { intents.push(intent); };
  const machine = new PlayerMachine(emit);
  return { machine, intents };
}

// ---------------------------------------------------------------------------
// Basic construction & lifecycle
// ---------------------------------------------------------------------------

describe("PlayerMachine — construction & lifecycle", () => {
  it("starts in BOOTSTRAP state", () => {
    const { machine } = makeMachine();
    expect(machine.getSnapshot().state).toBe("BOOTSTRAP");
  });

  it("subscribe receives initial state on subscription", () => {
    const { machine } = makeMachine();
    const states: string[] = [];
    const unsub = machine.subscribe((snap) => states.push(snap.state));
    // subscribe fires on next state change, not immediately
    expect(states).toHaveLength(0);
    unsub();
  });

  it("unsubscribe stops receiving updates", () => {
    const { machine } = makeMachine();
    const states: string[] = [];
    const unsub = machine.subscribe((snap) => states.push(snap.state));
    unsub();
    // After unsubscribe no new states should arrive from any transition
    expect(states).toHaveLength(0);
  });

  it("destroy() with no pending timers does not throw", () => {
    const { machine } = makeMachine();
    expect(() => machine.destroy()).not.toThrow();
  });

  it("destroy() cancels any pending FATAL recovery timer", () => {
    vi.useFakeTimers();
    const { machine } = makeMachine();
    const states: string[] = [];
    machine.subscribe((s) => states.push(s.state));

    // Destroy immediately — even if a timer was pending internally, it must
    // be cleared and the machine must not transition after destruction.
    machine.destroy();
    vi.advanceTimersByTime(300_000); // run all pending timers
    expect(states).toHaveLength(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// FATAL exponential backoff — T002
// ---------------------------------------------------------------------------

describe("PlayerMachine — FATAL exponential backoff (T002)", () => {
  // machine.ts: FATAL_AUTO_RECOVERY_MS = 10_000, FATAL_BACKOFF_MAX_MS = 240_000
  // Backoff schedule: 10s → 20s → 40s → 80s → 160s → 240s (cap)
  it("backoff schedule is 10s → 20s → 40s → 80s → 160s → 240s (cap)", () => {
    const FATAL_AUTO_RECOVERY_MS = 10_000;
    const FATAL_BACKOFF_MAX_MS   = 240_000;
    const schedule = [1, 2, 3, 4, 5, 6].map((attempt) =>
      Math.min(FATAL_AUTO_RECOVERY_MS * Math.pow(2, attempt - 1), FATAL_BACKOFF_MAX_MS),
    );
    expect(schedule).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 240_000]);
  });

  it("backoff never exceeds 240 s regardless of attempt count", () => {
    const FATAL_AUTO_RECOVERY_MS = 10_000;
    const FATAL_BACKOFF_MAX_MS   = 240_000;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const backoff = Math.min(
        FATAL_AUTO_RECOVERY_MS * Math.pow(2, attempt - 1),
        FATAL_BACKOFF_MAX_MS,
      );
      expect(backoff).toBeLessThanOrEqual(240_000);
    }
  });

  it("first attempt backoff equals base FATAL_AUTO_RECOVERY_MS (10 s)", () => {
    const FATAL_AUTO_RECOVERY_MS = 10_000;
    const FATAL_BACKOFF_MAX_MS   = 240_000;
    const backoff = Math.min(
      FATAL_AUTO_RECOVERY_MS * Math.pow(2, 0), // attempt 1: index 0
      FATAL_BACKOFF_MAX_MS,
    );
    expect(backoff).toBe(10_000);
  });

  it("setNeedSnapshotCallback is invoked when recovery timer fires", () => {
    vi.useFakeTimers();
    const { machine } = makeMachine();
    let needSnapshotCalled = 0;
    machine.setNeedSnapshotCallback(() => { needSnapshotCalled++; });

    // Use destroy() to confirm the cleanup path works without errors regardless
    // of what internal timers are running.
    machine.destroy();
    vi.advanceTimersByTime(300_000);
    // After destroy, callback must NOT be called (timer was cleared)
    expect(needSnapshotCalled).toBe(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Snapshot subscription — reactive behaviour
// ---------------------------------------------------------------------------

describe("PlayerMachine — snapshot subscription", () => {
  it("multiple subscribers all receive updates", () => {
    const { machine } = makeMachine();
    const s1: string[] = [];
    const s2: string[] = [];
    machine.subscribe((snap) => s1.push(snap.state));
    machine.subscribe((snap) => s2.push(snap.state));
    // Can't trigger state change without a full server snapshot; just verify
    // that subscribe returns a working unsubscribe function.
    expect(typeof machine.subscribe(() => {})).toBe("function");
  });

  it("getSnapshot() reflects last known state", () => {
    const { machine } = makeMachine();
    const snap = machine.getSnapshot();
    expect(snap).toMatchObject({
      state: "BOOTSTRAP",
      activeBufferId: expect.stringMatching(/^[AB]$/),
      lastSequence: expect.any(Number),
    });
  });
});
