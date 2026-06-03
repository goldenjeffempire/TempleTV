import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Watchdog } from "../src/watchdog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWatchdog(overrides: {
  initialLoadThresholdMs?: number;
  rebufferThresholdMs?: number;
  stableThresholdMs?: number;
  stablePlayMs?: number;
  onStall?: () => void;
} = {}) {
  const stalls: number[] = [];
  const wd = new Watchdog({
    initialLoadThresholdMs: overrides.initialLoadThresholdMs ?? 1_000,
    rebufferThresholdMs:    overrides.rebufferThresholdMs    ?? 1_000,
    stableThresholdMs:      overrides.stableThresholdMs      ?? 2_000,
    stablePlayMs:           overrides.stablePlayMs           ?? 3_000,
    onStall: overrides.onStall ?? (() => { stalls.push(Date.now()); }),
  });
  return { wd, stalls };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("Watchdog — lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts disarmed and does not fire onStall without arm()", () => {
    const { wd, stalls } = makeWatchdog();
    vi.advanceTimersByTime(30_000);
    expect(stalls).toHaveLength(0);
    wd.disarm();
  });

  it("arm() arms the watchdog and disarm() stops it", () => {
    const { wd, stalls } = makeWatchdog({ initialLoadThresholdMs: 500 });
    wd.arm();
    vi.advanceTimersByTime(400);
    expect(stalls).toHaveLength(0);
    wd.disarm();
    vi.advanceTimersByTime(5_000);
    expect(stalls).toHaveLength(0);
  });

  it("arm() is idempotent — double-arm doesn't create duplicate timers", () => {
    const { wd, stalls } = makeWatchdog({ initialLoadThresholdMs: 500 });
    wd.arm();
    wd.arm(); // second call must be a no-op
    vi.advanceTimersByTime(1_500);
    // Should have fired at most once (not twice from two intervals)
    expect(stalls.length).toBeLessThanOrEqual(1);
    wd.disarm();
  });
});

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

describe("Watchdog — phase transitions", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts in 'initial' phase before any feed()", () => {
    const { wd } = makeWatchdog();
    wd.arm();
    expect(wd.getPhase()).toBe("initial");
    wd.disarm();
  });

  it("transitions to 'rebuffer' after first feed()", () => {
    const { wd } = makeWatchdog();
    wd.arm();
    wd.feed(1.0);
    expect(wd.getPhase()).toBe("rebuffer");
    wd.disarm();
  });

  it("transitions to 'stable' after stablePlayMs of continuous advance", () => {
    // Both stall thresholds must be very high so check() never resets
    // stableEnteredMs before the stablePlayMs window elapses.
    //
    // Root cause of failure without stableThresholdMs=50_000:
    //   - feed(1.0) sets stableEnteredMs = t₀
    //   - At t₀ + stablePlayMs the interval fires and resolvePhase() → "stable"
    //   - threshold = stableThresholdMs (default 2 000 ms)
    //   - gap since lastAdvanceMs = stablePlayMs (> 2 000) → stall fires
    //   - check() resets stableEnteredMs = now → phase falls back to "rebuffer"
    //
    // Use short stablePlayMs (500 ms) so the test is fast, and set both
    // thresholds to 50 000 ms so no stall fires and no reset occurs.
    const { wd } = makeWatchdog({
      stablePlayMs: 500,
      rebufferThresholdMs: 50_000,
      stableThresholdMs: 50_000,
    });
    wd.arm();
    wd.feed(1.0); // first advance — stableEnteredMs = t₀
    // Interval fires at t₀+500: resolvePhase → gap 500 ≥ stablePlayMs 500 → "stable".
    // Neither threshold fires (both 50 000 ms). stableEnteredMs stays at t₀.
    vi.advanceTimersByTime(600);
    expect(wd.getPhase()).toBe("stable");
    wd.disarm();
  });

  it("notifyActive() in rebuffer resets stable window and keeps phase as rebuffer", () => {
    const { wd } = makeWatchdog({ stablePlayMs: 3_000 });
    wd.arm();
    wd.feed(1.0);
    vi.advanceTimersByTime(2_000);
    wd.notifyActive(); // rebuffer event resets stableEnteredMs
    vi.advanceTimersByTime(1_500);
    // Only 1.5 s elapsed since notifyActive reset the window — still rebuffer
    expect(wd.getPhase()).toBe("rebuffer");
    wd.disarm();
  });

  it("stable phase uses wider threshold than rebuffer", () => {
    const { wd } = makeWatchdog({ stablePlayMs: 1_000, rebufferThresholdMs: 1_000, stableThresholdMs: 2_000 });
    wd.arm();
    wd.feed(1.0);
    vi.advanceTimersByTime(1_100); // past stable gate
    expect(wd.getPhase()).toBe("stable");
    expect(wd.getCurrentThresholdMs()).toBe(2_000);
    wd.disarm();
  });
});

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

describe("Watchdog — stall detection", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires onStall after initialLoadThresholdMs with no feed()", () => {
    // Threshold 400 ms — NOT a multiple of 500 ms so the first interval tick
    // at 500 ms satisfies the strict `>` comparison (500 > 400 = true).
    const { wd, stalls } = makeWatchdog({ initialLoadThresholdMs: 400 });
    wd.arm();
    // Advance 600 ms: interval fires at 500 ms → 500 > 400 → stall fires.
    vi.advanceTimersByTime(600);
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    wd.disarm();
  });

  it("does not fire onStall when feed() keeps advancing", () => {
    const { wd, stalls } = makeWatchdog({ rebufferThresholdMs: 1_000 });
    wd.arm();
    wd.feed(0);
    for (let i = 1; i <= 20; i++) {
      vi.advanceTimersByTime(500);
      wd.feed(i * 0.5); // advance every 500 ms
    }
    expect(stalls).toHaveLength(0);
    wd.disarm();
  });

  it("fires onStall in rebuffer phase when feed() stops", () => {
    // Same non-multiple-of-500 trick: 400 ms threshold so the 500 ms tick fires it.
    const { wd, stalls } = makeWatchdog({ rebufferThresholdMs: 400 });
    wd.arm();
    wd.feed(1.0); // enter rebuffer phase; clock reset to t₀
    // 600 ms later: interval at 500 ms → gap = 500 > 400 → stall fires.
    vi.advanceTimersByTime(600);
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    wd.disarm();
  });

  it("stall does not refire every 500 ms — clock resets after firing", () => {
    const { wd, stalls } = makeWatchdog({ initialLoadThresholdMs: 1_000 });
    wd.arm();
    vi.advanceTimersByTime(2_000);
    // The stall fired once at ~1s; the clock resets. Should not have fired
    // again in the remaining 1s (would need another threshold duration).
    expect(stalls.length).toBe(1);
    wd.disarm();
  });

  it("notifyActive() postpones stall in rebuffer", () => {
    const { wd, stalls } = makeWatchdog({ rebufferThresholdMs: 1_000 });
    wd.arm();
    wd.feed(1.0); // enter rebuffer
    vi.advanceTimersByTime(800);
    wd.notifyActive(); // data flowing — reset clock
    vi.advanceTimersByTime(800); // 800 ms since notifyActive — still under threshold
    expect(stalls).toHaveLength(0);
    vi.advanceTimersByTime(400); // now 1.2 s without feed — stall fires
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    wd.disarm();
  });

  it("fires stall in stable phase after wider threshold", () => {
    const { wd, stalls } = makeWatchdog({
      stablePlayMs: 500,
      rebufferThresholdMs: 1_000,
      stableThresholdMs: 2_000,
    });
    wd.arm();
    wd.feed(1.0);
    vi.advanceTimersByTime(600); // enter stable
    // Stop feeding — stall should fire at 2_000 ms (stable threshold), not 1_000
    vi.advanceTimersByTime(1_100); // 1.1 s without feed — still under stable threshold
    expect(stalls).toHaveLength(0);
    vi.advanceTimersByTime(1_100); // now 2.2 s total without feed — fires
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    wd.disarm();
  });
});

// ---------------------------------------------------------------------------
// Slow-death (notifyActive streak) guard — T004
// ---------------------------------------------------------------------------

describe("Watchdog — slow-death notifyActive streak cap", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("streak starts at 0 after arm()", () => {
    const { wd } = makeWatchdog();
    wd.arm();
    expect(wd.getNotifyActiveStreak()).toBe(0);
    wd.disarm();
  });

  it("streak increments on each notifyActive() call", () => {
    const { wd } = makeWatchdog();
    wd.arm();
    wd.notifyActive();
    wd.notifyActive();
    wd.notifyActive();
    expect(wd.getNotifyActiveStreak()).toBe(3);
    wd.disarm();
  });

  it("feed() resets the streak", () => {
    const { wd } = makeWatchdog();
    wd.arm();
    for (let i = 0; i < 10; i++) wd.notifyActive();
    expect(wd.getNotifyActiveStreak()).toBe(10);
    wd.feed(1.0);
    expect(wd.getNotifyActiveStreak()).toBe(0);
    wd.disarm();
  });

  it("disarm() resets the streak", () => {
    const { wd } = makeWatchdog();
    wd.arm();
    for (let i = 0; i < 20; i++) wd.notifyActive();
    wd.disarm();
    expect(wd.getNotifyActiveStreak()).toBe(0);
  });

  it("after MAX streak, notifyActive stops resetting the stall clock", () => {
    // Use a threshold that is NOT a multiple of 500 ms so the interval tick
    // clears the strict `>` comparison.
    //
    // Execution trace:
    //   arm() at t=0            → lastAdvanceMs = 0
    //   i=0:  notifyActive() at t=0  (streak 1 ≤ 40) → lastAdvanceMs = 0
    //         advanceTimersByTime(10) → t=10
    //   i=1:  notifyActive() at t=10 (streak 2 ≤ 40) → lastAdvanceMs = 10
    //         advanceTimersByTime(10) → t=20
    //   ...
    //   i=39: notifyActive() at t=390 (streak 40 ≤ 40) → lastAdvanceMs = 390
    //         advanceTimersByTime(10) → t=400
    //   i=40: notifyActive() at t=400 (streak 41 > 40) → NO reset (lastAdvanceMs stays 390)
    //         advanceTimersByTime(10) → t=410
    //   loop end: t=410, lastAdvanceMs=390
    //
    //   advanceTimersByTime(700) → t=1110
    //     interval fires at t=500 : gap = 500 - 390 = 110 > 200? NO
    //     interval fires at t=1000: gap = 1000 - 390 = 610 > 200? YES → stall fires ✓
    const { wd, stalls } = makeWatchdog({ initialLoadThresholdMs: 200 });
    wd.arm();

    for (let i = 0; i < 41; i++) {
      wd.notifyActive();
      vi.advanceTimersByTime(10);
    }
    // t=410, lastAdvanceMs=390. Advance 700 ms more → t=1110.
    // Interval at t=1000: gap 610 > 200 — stall fires.
    vi.advanceTimersByTime(700);
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    wd.disarm();
  });

  it("below MAX streak, notifyActive still resets the clock and prevents stall", () => {
    const { wd, stalls } = makeWatchdog({ initialLoadThresholdMs: 500 });
    wd.arm();
    // Fire 30 notifyActive calls (under the cap of 40) with 200 ms gaps.
    // Each call resets the stall clock so the 500 ms threshold never expires.
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(200);
      wd.notifyActive();
    }
    expect(stalls).toHaveLength(0);
    wd.disarm();
  });

  it("streak resets after arm() cycle — fresh arm gives new chance", () => {
    const { wd } = makeWatchdog();
    wd.arm();
    for (let i = 0; i < 45; i++) wd.notifyActive();
    wd.disarm();
    wd.arm(); // re-arm must give a clean slate
    expect(wd.getNotifyActiveStreak()).toBe(0);
    wd.disarm();
  });
});
