/**
 * FailoverHandler unit tests.
 *
 * These tests run in a plain Node/Vitest environment (no DOM), which exercises
 * the `bindDomEvents: false` / `notifyOnline` / `notifyOffline` code paths that
 * React Native consumers use (DOM online/offline events never fire on RN).
 *
 * Covers:
 *  • Primary retry budget
 *  • Failover activation + exhaustion
 *  • notifyOffline() suspends retry budget (no DOM events needed)
 *  • notifyOnline() resumes and resets budget
 *  • DOM auto-binding guard (bindDomEvents: false)
 *  • reset() clears offline-waiting state
 */

import { describe, it, expect, vi } from "vitest";
import { FailoverHandler } from "./FailoverHandler";
import type { FailoverCallbacks } from "./FailoverHandler";

function makeCbs(): { cb: FailoverCallbacks; skips: number; activations: string[]; waitStates: boolean[] } {
  const activations: string[] = [];
  const waitStates: boolean[] = [];
  let skips = 0;
  const cb: FailoverCallbacks = {
    onActivateFailover: (url) => activations.push(url),
    onSkipToNext:       ()    => skips++,
    onOfflineWaiting:   (w)   => waitStates.push(w),
  };
  return { cb, skips: 0, activations, waitStates };
}

// Helper: make a handler with DOM events disabled (simulates React Native)
function makeRnHandler(callbacks: FailoverCallbacks): FailoverHandler {
  return new FailoverHandler(callbacks, { bindDomEvents: false });
}

// ---------------------------------------------------------------------------
// Primary retry budget
// ---------------------------------------------------------------------------

describe("FailoverHandler — primary retry budget", () => {
  it("first 3 errors are absorbed (primary budget = 3)", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);

    expect(h.handleError({ isNetwork: false })).toBe(true);  // 1st
    expect(h.handleError({ isNetwork: false })).toBe(true);  // 2nd
    expect(h.handleError({ isNetwork: false })).toBe(true);  // 3rd — budget exhausted
  });

  it("4th error with no failover → skip", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.handleError({ isNetwork: false }); // 1
    h.handleError({ isNetwork: false }); // 2
    h.handleError({ isNetwork: false }); // 3
    const result = h.handleError({ isNetwork: false }); // 4 — no failover → skip
    expect(result).toBe(false);
    expect(cb.onSkipToNext).toHaveBeenCalled();
  });

  it("4th error with failover URL → activates failover instead of skip", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.setFailoverUrl("https://backup.example.com/stream.m3u8");
    h.handleError({ isNetwork: false }); // 1
    h.handleError({ isNetwork: false }); // 2
    h.handleError({ isNetwork: false }); // 3 — budget exhausted, failover takes over
    expect(cb.onActivateFailover).toHaveBeenCalledWith("https://backup.example.com/stream.m3u8");
    expect(cb.onSkipToNext).not.toHaveBeenCalled();
  });

  it("reset() restores full primary budget", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.handleError({ isNetwork: false }); // 1
    h.handleError({ isNetwork: false }); // 2
    h.reset();
    // After reset, budget is fresh again
    expect(h.handleError({ isNetwork: false })).toBe(true); // 1 (fresh)
    expect(cb.onSkipToNext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failover activation + exhaustion
// ---------------------------------------------------------------------------

describe("FailoverHandler — failover source", () => {
  it("failover budget is 2 errors before skip", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.setFailoverUrl("https://backup.example.com/stream.m3u8");

    // Exhaust primary
    h.handleError({ isNetwork: false }); // primary 1
    h.handleError({ isNetwork: false }); // primary 2
    h.handleError({ isNetwork: false }); // primary 3 → activates failover
    expect(cb.onActivateFailover).toHaveBeenCalledTimes(1);

    // Failover budget: 2 errors absorbed
    expect(h.handleError({ isNetwork: false })).toBe(true);  // failover 1
    expect(h.handleError({ isNetwork: false })).toBe(true);  // failover 2
    // Failover exhausted → skip
    const result = h.handleError({ isNetwork: false });
    expect(result).toBe(false);
    expect(cb.onSkipToNext).toHaveBeenCalledTimes(1);
  });

  it("getState() reflects usingFailover after activation", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.setFailoverUrl("https://backup.example.com/stream.m3u8");
    expect(h.getState().usingFailover).toBe(false);
    h.handleError({ isNetwork: false }); // 1
    h.handleError({ isNetwork: false }); // 2
    h.handleError({ isNetwork: false }); // 3 → activate failover
    expect(h.getState().usingFailover).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// notifyOffline() / notifyOnline() — React Native code path
// ---------------------------------------------------------------------------

describe("FailoverHandler — notifyOffline / notifyOnline (RN code path)", () => {
  it("notifyOffline() enters offline-waiting state and fires onOfflineWaiting(true)", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.notifyOffline();
    expect(cb.onOfflineWaiting).toHaveBeenCalledWith(true);
    expect(h.getState().offlineWaiting).toBe(true);
  });

  it("notifyOffline() is idempotent — second call does not fire callback again", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.notifyOffline();
    h.notifyOffline();
    expect(cb.onOfflineWaiting).toHaveBeenCalledTimes(1);
  });

  it("handleError() while offlineWaiting returns true without burning retry budget", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.notifyOffline();
    // Burn many errors — none should reduce the retry budget
    for (let i = 0; i < 10; i++) {
      expect(h.handleError({ isNetwork: true })).toBe(true);
    }
    // After coming back online, the full budget must still be available
    h.notifyOnline();
    expect(cb.onSkipToNext).not.toHaveBeenCalled();
  });

  it("notifyOnline() clears offline-waiting and resets retry counters", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    // Burn some retries before going offline
    h.handleError({ isNetwork: false }); // 1
    h.notifyOffline();
    h.notifyOnline();
    // State should be clear
    expect(h.getState().offlineWaiting).toBe(false);
    expect(cb.onOfflineWaiting).toHaveBeenCalledWith(false);
  });

  it("notifyOnline() when not offlineWaiting is a no-op", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.notifyOnline(); // no prior notifyOffline
    expect(cb.onOfflineWaiting).not.toHaveBeenCalled();
  });

  it("resume after notifyOnline() allows fresh primary retries", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.notifyOffline();
    h.handleError({ isNetwork: false }); // consumed inside offline-wait, no budget burn
    h.notifyOnline();
    // Now should have a fresh budget — 3 errors absorbed
    expect(h.handleError({ isNetwork: false })).toBe(true); // 1
    expect(h.handleError({ isNetwork: false })).toBe(true); // 2
    expect(h.handleError({ isNetwork: false })).toBe(true); // 3
    expect(cb.onSkipToNext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bindDomEvents: false guard
// ---------------------------------------------------------------------------

describe("FailoverHandler — bindDomEvents option", () => {
  it("default constructor does not throw in Node environment (no DOM)", () => {
    // Node has no `document`, so _isDomEnvironment() returns false and
    // window.addEventListener is never called.
    const { cb } = makeCbs();
    expect(() => new FailoverHandler(cb)).not.toThrow();
  });

  it("bindDomEvents: false skips DOM binding without error", () => {
    const { cb } = makeCbs();
    expect(() => makeRnHandler(cb)).not.toThrow();
  });

  it("unbind() does not throw when no DOM is present", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    expect(() => h.unbind()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// reset() edge cases
// ---------------------------------------------------------------------------

describe("FailoverHandler — reset()", () => {
  it("reset() while offlineWaiting clears it and fires onOfflineWaiting(false)", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.notifyOffline();
    expect(h.getState().offlineWaiting).toBe(true);
    h.reset();
    expect(h.getState().offlineWaiting).toBe(false);
    expect(cb.onOfflineWaiting).toHaveBeenLastCalledWith(false);
  });

  it("reset() clears usingFailover", () => {
    const { cb } = makeCbs();
    const h = makeRnHandler(cb);
    h.setFailoverUrl("https://backup.example.com/stream.m3u8");
    h.handleError({ isNetwork: false }); // 1
    h.handleError({ isNetwork: false }); // 2
    h.handleError({ isNetwork: false }); // 3 → activate failover
    expect(h.getState().usingFailover).toBe(true);
    h.reset();
    expect(h.getState().usingFailover).toBe(false);
  });
});
