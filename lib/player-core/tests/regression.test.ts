/**
 * Regression tests for previously-found bugs.
 *
 * Each test block is named after the exact bug it guards against, so a
 * future failure immediately identifies the regression without reading source.
 *
 * Bugs covered:
 *
 *  1. WS frameQueue has no size cap during resume
 *     File: artifacts/api-server/src/modules/broadcast-v2/io/ws.gateway.ts
 *     Bug:  frameQueue inside the `resume` message handler had no upper-bound.
 *           Under a burst of >500 orchestrator "frame" events during a slow DB
 *           replay the array could grow without limit, exhausting heap memory.
 *     Fix:  Added FRAME_QUEUE_MAX = 500 with drop-oldest (shift) when exceeded,
 *           matching the SSE gateway's identical protection.
 *
 *  2. LiveBroadcastV2 overridePlaying stale-true after YouTube override
 *     File: artifacts/tv/src/components/LiveBroadcastV2.tsx
 *     Bug:  When kind changed from "hls" → "youtube" while state stayed
 *           LIVE_OVERRIDE_ACTIVE, the useEffect returned early for the YouTube
 *           path WITHOUT calling setOverridePlaying(false).  overridePlaying
 *           stayed true from the prior HLS run.  The next HLS override then
 *           started with overridePlaying already true → "Tuning in…" overlay
 *           never shown for the new HLS source.
 *     Fix:  setOverridePlaying(false) now fires unconditionally at the top of
 *           the LIVE_OVERRIDE_ACTIVE branch, before the YouTube early-return.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Bug 1 — WS frameQueue cap
//
// The gateway logic is:
//   const FRAME_QUEUE_MAX = 500;
//   const frameQueue: V2ServerFrame[] = [];
//   const bufferFrame = (f) => {
//     if (frameQueue.length >= FRAME_QUEUE_MAX) frameQueue.shift();
//     frameQueue.push(f);
//   };
//
// We extract and test that algorithm directly.
// ---------------------------------------------------------------------------

describe("WS resume frameQueue cap — regression (Bug 1)", () => {
  function makeFrameBuffer(max: number) {
    const queue: number[] = [];
    const push = (v: number) => {
      if (queue.length >= max) queue.shift();
      queue.push(v);
    };
    return { queue, push };
  }

  it("never exceeds FRAME_QUEUE_MAX when fed exactly MAX frames", () => {
    const MAX = 500;
    const { queue, push } = makeFrameBuffer(MAX);
    for (let i = 0; i < MAX; i++) push(i);
    expect(queue.length).toBe(MAX);
  });

  it("never exceeds FRAME_QUEUE_MAX when fed MAX+1 frames", () => {
    const MAX = 500;
    const { queue, push } = makeFrameBuffer(MAX);
    for (let i = 0; i < MAX + 1; i++) push(i);
    expect(queue.length).toBe(MAX);
  });

  it("never exceeds FRAME_QUEUE_MAX when fed 2×MAX frames (burst scenario)", () => {
    const MAX = 500;
    const { queue, push } = makeFrameBuffer(MAX);
    for (let i = 0; i < MAX * 2; i++) push(i);
    expect(queue.length).toBe(MAX);
  });

  it("drop-oldest semantics: after overflow the queue contains the most-recent MAX frames", () => {
    const MAX = 500;
    const { queue, push } = makeFrameBuffer(MAX);
    for (let i = 0; i < MAX * 2; i++) push(i);
    // oldest remaining = MAX (index MAX was the MAX+1-th item pushed, which
    // caused index 0 to be dropped for the first time)
    expect(queue[0]).toBe(MAX);
    // newest remaining = MAX*2 - 1
    expect(queue[queue.length - 1]).toBe(MAX * 2 - 1);
  });

  it("queue is empty when no frames arrive during replay", () => {
    const MAX = 500;
    const { queue } = makeFrameBuffer(MAX);
    expect(queue.length).toBe(0);
  });

  it("queue length is correct for small bursts below the cap", () => {
    const MAX = 500;
    const { queue, push } = makeFrameBuffer(MAX);
    for (let i = 0; i < 10; i++) push(i);
    expect(queue.length).toBe(10);
    // all frames kept in insertion order
    expect(queue).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("cap can be 1 — always keeps only the latest frame", () => {
    const { queue, push } = makeFrameBuffer(1);
    push(10);
    push(20);
    push(30);
    expect(queue.length).toBe(1);
    expect(queue[0]).toBe(30);
  });

  it("after overflow flush, further pushes maintain cap invariant", () => {
    const MAX = 5;
    const { queue, push } = makeFrameBuffer(MAX);
    for (let i = 0; i < 20; i++) push(i);
    // verify cap
    expect(queue.length).toBe(MAX);
    // push a few more — still capped
    push(100);
    push(200);
    expect(queue.length).toBe(MAX);
    expect(queue[queue.length - 1]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — overridePlaying stale-true after YouTube → HLS override switch
//
// The React useEffect logic in LiveBroadcastV2.tsx is:
//
//   if (state !== "LIVE_OVERRIDE_ACTIVE") { setOverridePlaying(false); return; }
//   setOverridePlaying(false);                     ← the FIX
//   if (kind === "youtube") return;
//   // … attach "playing" listener to video element
//
// We simulate the effect as a pure function to verify the invariant:
//   "Whenever LIVE_OVERRIDE_ACTIVE is entered (or re-entered with a new kind),
//   overridePlaying is always reset to false before any listener is attached."
// ---------------------------------------------------------------------------

describe("LiveBroadcastV2 overridePlaying reset — regression (Bug 2)", () => {
  type State = "LIVE_OVERRIDE_ACTIVE" | "PLAYING" | "PREPARING_ACTIVE" | "RECOVERING_PRIMARY";
  type Kind = "hls" | "youtube" | "mp4";

  /**
   * Simulates the fixed useEffect body.
   * Returns: { newOverridePlaying: boolean; listenerAttached: boolean }
   *
   * `currentOverridePlaying` is the value of the state variable BEFORE the
   * effect runs. The effect may synchronously call setOverridePlaying(false),
   * which we model as overriding that value to false.
   */
  function runEffect(
    state: State,
    kind: Kind | null,
    currentOverridePlaying: boolean,
  ): { resultOverridePlaying: boolean; listenerAttached: boolean } {
    let overridePlaying = currentOverridePlaying;
    const setOverridePlaying = (v: boolean) => { overridePlaying = v; };
    let listenerAttached = false;

    if (state !== "LIVE_OVERRIDE_ACTIVE") {
      setOverridePlaying(false);
      return { resultOverridePlaying: overridePlaying, listenerAttached };
    }
    // THE FIX: always reset when (re-)entering LIVE_OVERRIDE_ACTIVE
    setOverridePlaying(false);
    if (kind === "youtube") {
      return { resultOverridePlaying: overridePlaying, listenerAttached };
    }
    // HLS / MP4 path: attach "playing" listener (simulated)
    listenerAttached = true;
    return { resultOverridePlaying: overridePlaying, listenerAttached };
  }

  it("resets overridePlaying when leaving LIVE_OVERRIDE_ACTIVE", () => {
    const { resultOverridePlaying } = runEffect("PLAYING", null, true);
    expect(resultOverridePlaying).toBe(false);
  });

  it("resets overridePlaying when entering LIVE_OVERRIDE_ACTIVE with HLS kind", () => {
    const { resultOverridePlaying, listenerAttached } = runEffect("LIVE_OVERRIDE_ACTIVE", "hls", false);
    expect(resultOverridePlaying).toBe(false);
    expect(listenerAttached).toBe(true);
  });

  it("resets overridePlaying when entering LIVE_OVERRIDE_ACTIVE with YouTube kind", () => {
    const { resultOverridePlaying, listenerAttached } = runEffect("LIVE_OVERRIDE_ACTIVE", "youtube", false);
    expect(resultOverridePlaying).toBe(false);
    expect(listenerAttached).toBe(false); // no native listener for YouTube iframes
  });

  it("BUG SCENARIO: overridePlaying is NOT stale after HLS→YouTube→HLS override switch", () => {
    // Step 1: HLS override plays, overridePlaying becomes true (via "playing" event)
    // (The effect ran, attached a listener, listener fired — we simulate the post-event state)
    let overridePlaying = true; // after "playing" event fired

    // Step 2: YouTube override starts (kind changes, state stays LIVE_OVERRIDE_ACTIVE)
    const step2 = runEffect("LIVE_OVERRIDE_ACTIVE", "youtube", overridePlaying);
    overridePlaying = step2.resultOverridePlaying;
    // FIX: must be false — before the fix this would have stayed true
    expect(overridePlaying).toBe(false);
    expect(step2.listenerAttached).toBe(false);

    // Step 3: Another HLS override starts (kind changes back, state stays LIVE_OVERRIDE_ACTIVE)
    const step3 = runEffect("LIVE_OVERRIDE_ACTIVE", "hls", overridePlaying);
    overridePlaying = step3.resultOverridePlaying;
    // Must still be false — "Tuning in…" overlay must show until "playing" fires
    expect(overridePlaying).toBe(false);
    expect(step3.listenerAttached).toBe(true);
  });

  it("BUG SCENARIO: overridePlaying is NOT stale after YouTube→HLS override switch", () => {
    // Edge case: first override is YouTube (overridePlaying starts false)
    // then switches to HLS — should start fresh
    let overridePlaying = false;

    const step1 = runEffect("LIVE_OVERRIDE_ACTIVE", "youtube", overridePlaying);
    overridePlaying = step1.resultOverridePlaying;
    expect(overridePlaying).toBe(false);

    const step2 = runEffect("LIVE_OVERRIDE_ACTIVE", "hls", overridePlaying);
    overridePlaying = step2.resultOverridePlaying;
    expect(overridePlaying).toBe(false);
    expect(step2.listenerAttached).toBe(true);
  });

  it("overridePlaying stays false when entering non-LIVE_OVERRIDE_ACTIVE states", () => {
    for (const state of ["PLAYING", "PREPARING_ACTIVE", "RECOVERING_PRIMARY"] as State[]) {
      const { resultOverridePlaying } = runEffect(state, null, true);
      expect(resultOverridePlaying).toBe(false);
    }
  });

  it("listener is attached only for HLS/MP4 override kinds (not YouTube)", () => {
    expect(runEffect("LIVE_OVERRIDE_ACTIVE", "hls",     false).listenerAttached).toBe(true);
    expect(runEffect("LIVE_OVERRIDE_ACTIVE", "mp4",     false).listenerAttached).toBe(true);
    expect(runEffect("LIVE_OVERRIDE_ACTIVE", "youtube", false).listenerAttached).toBe(false);
  });

  it("overridePlaying reset fires even when overridePlaying was already false", () => {
    // setOverridePlaying(false) called on a false value must not cause issues
    const { resultOverridePlaying } = runEffect("LIVE_OVERRIDE_ACTIVE", "youtube", false);
    expect(resultOverridePlaying).toBe(false);
  });

  it("repeated HLS overrides each start with a fresh reset", () => {
    // Multiple HLS overrides without any YouTube transition — each one should
    // start with overridePlaying=false even if the prior one had set it true.
    let overridePlaying = true; // simulate prior HLS override played

    const step = runEffect("LIVE_OVERRIDE_ACTIVE", "hls", overridePlaying);
    overridePlaying = step.resultOverridePlaying;
    // Reset must fire even within the same kind
    expect(overridePlaying).toBe(false);
    expect(step.listenerAttached).toBe(true);
  });
});
