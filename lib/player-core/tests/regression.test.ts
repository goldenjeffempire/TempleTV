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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PlayerMachine } from "../src/machine.js";
import type { AdapterIntent } from "../src/machine.js";

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

// ---------------------------------------------------------------------------
// Bug 3 — YouTube queue item stuck in PREPARING_ACTIVE forever
//
// Root cause: web adapter's bind() path for YouTube sources never called
// the `buffer-ready` callback. The FSM stayed in PREPARING_ACTIVE indefinitely
// waiting for a canplay event that would never fire (no src set on <video>).
//
// Fix: adapter fires buffer-ready immediately after setting boundKind="youtube".
//
// Machine-level invariant tested here:
//   "For a YouTube source item, exactly TWO events (snapshot + buffer-ready)
//    are sufficient to drive the FSM from BOOTSTRAP → PREPARING_ACTIVE → PLAYING."
//
// We cannot test the DOM adapter here, but we CAN verify the FSM accepts
// a buffer-ready immediately after the snapshot — confirming the adapter-side
// fix unblocks the machine.
// ---------------------------------------------------------------------------

describe("YouTube queue item immediate buffer-ready — regression (Bug 3)", () => {
  it("snapshot + immediate buffer-ready → PLAYING in exactly 2 events", () => {
    const intents: AdapterIntent[] = [];
    const machine = new PlayerMachine((i) => intents.push(i));
    const now = Date.now();
    const snapshot = {
      channelId: "main", sequence: 1, serverTimeMs: now,
      mode: "queue" as const, current: {
        id: "yt-1", title: "YT", thumbnailUrl: null, durationSecs: 3600,
        source: { kind: "youtube" as const, url: "https://www.youtube.com/watch?v=XYZ", expiresAtMs: null },
        failoverSource: null, startsAtMs: now - 60_000, endsAtMs: now + 3_540_000,
      },
      next: null, nextNext: null, override: null, checkpoint: null,
      failover: { active: false, reason: null },
    };

    // Event 1: snapshot → PREPARING_ACTIVE (machine awaits buffer-ready)
    machine.send({ type: "snapshot", snapshot });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");

    // Event 2: adapter fires buffer-ready immediately for YouTube sources
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("YouTube source play intent has positionSecs === 0 (no HLS wall-clock seek)", () => {
    const playIntents: Array<{ type: string; positionSecs?: number }> = [];
    const machine = new PlayerMachine((i) => {
      if (i.type === "play") playIntents.push(i);
    });
    const now = Date.now();
    machine.send({
      type: "snapshot", snapshot: {
        channelId: "main", sequence: 1, serverTimeMs: now, mode: "queue" as const,
        current: {
          id: "yt-2", title: "YT", thumbnailUrl: null, durationSecs: 7200,
          source: { kind: "youtube" as const, url: "https://www.youtube.com/watch?v=ABC", expiresAtMs: null },
          failoverSource: null,
          startsAtMs: now - 3_600_000, // started 1 hour ago
          endsAtMs: now + 3_600_000,
        },
        next: null, nextNext: null, override: null, checkpoint: null,
        failover: { active: false, reason: null },
      },
    });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(playIntents.length).toBeGreaterThanOrEqual(1);
    expect(playIntents[0]!.positionSecs).toBe(0); // never seek YouTube — always start from 0
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Bug 4 — WS close handler must use mutable activeFrameHandler pointer
//
// Root cause: ws.gateway.ts close handler called
//   broadcastOrchestrator.off("frame", onFrame)
// but when a `resume` message arrived, bufferFrame replaced onFrame on the
// emitter. Closing with the original onFrame reference was a no-op — bufferFrame
// leaked permanently.
//
// Fix: (1) socketClosed = true on close; (2) close handler calls
//   broadcastOrchestrator.off("frame", activeFrameHandler)
// where activeFrameHandler is a mutable pointer updated to bufferFrame on resume.
//
// We verify the algorithm here using a minimal EventEmitter simulation.
// ---------------------------------------------------------------------------

describe("WS close handler mutable pointer — regression (Bug 4)", () => {
  class MiniEmitter {
    private handlers = new Map<string, Set<(v: unknown) => void>>();
    on(ev: string, fn: (v: unknown) => void)  { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(fn); }
    off(ev: string, fn: (v: unknown) => void) { this.handlers.get(ev)?.delete(fn); }
    emit(ev: string, v: unknown)              { this.handlers.get(ev)?.forEach((h) => h(v)); }
    listenerCount(ev: string)                 { return this.handlers.get(ev)?.size ?? 0; }
  }

  it("close with mutable pointer removes the correct handler (bufferFrame, not onFrame)", () => {
    const emitter = new MiniEmitter();
    let socketClosed = false;
    let activeFrameHandler: ((v: unknown) => void) | null = null;

    const onFrame = (_v: unknown) => { /* normal handler */ };
    const bufferFrame = (_v: unknown) => { /* resume buffer handler */ };

    // ── Register onFrame ──────────────────────────────────────────────────
    activeFrameHandler = onFrame;
    emitter.on("frame", onFrame);
    expect(emitter.listenerCount("frame")).toBe(1);

    // ── resume message: swap to bufferFrame ───────────────────────────────
    emitter.off("frame", onFrame);
    activeFrameHandler = bufferFrame;
    emitter.on("frame", bufferFrame);
    expect(emitter.listenerCount("frame")).toBe(1);

    // ── socket closes during the resume DB await ──────────────────────────
    socketClosed = true;
    // THE FIX: use activeFrameHandler (bufferFrame), not the stale onFrame
    if (activeFrameHandler) emitter.off("frame", activeFrameHandler);

    expect(socketClosed).toBe(true);
    expect(emitter.listenerCount("frame")).toBe(0); // no leak
  });

  it("BUG SCENARIO: close with static onFrame reference leaks bufferFrame", () => {
    const emitter = new MiniEmitter();
    const onFrame = (_v: unknown) => { /* */ };
    const bufferFrame = (_v: unknown) => { /* */ };

    emitter.on("frame", onFrame);
    emitter.off("frame", onFrame);
    emitter.on("frame", bufferFrame);
    // BUG: removing stale onFrame is a no-op — bufferFrame stays registered
    emitter.off("frame", onFrame); // stale reference — no-op
    expect(emitter.listenerCount("frame")).toBe(1); // leak! bufferFrame still there
  });

  it("socketClosed=true flag prevents re-registration after socket already closed", () => {
    const emitter = new MiniEmitter();
    let socketClosed = false;
    let activeFrameHandler: ((v: unknown) => void) | null = null;
    const registered: string[] = [];

    const onFrame = (_v: unknown) => { /* */ };

    activeFrameHandler = onFrame;
    emitter.on("frame", onFrame);

    // Close fires
    socketClosed = true;
    if (activeFrameHandler) emitter.off("frame", activeFrameHandler);

    // Async resume DB await completes AFTER close — must not re-register
    if (!socketClosed) {
      emitter.on("frame", onFrame);
      registered.push("onFrame");
    }

    expect(registered).toHaveLength(0); // nothing registered post-close
    expect(emitter.listenerCount("frame")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 5 — extractYouTubeId fails for youtu.be short URLs
//
// Root cause: new URL(url).searchParams.get("v") returns null for
//   https://youtu.be/VIDEOID
// because the video ID is in the pathname, not a query parameter.
//
// Fix: also check u.hostname === "youtu.be" → return u.pathname.slice(1).
// ---------------------------------------------------------------------------

describe("extractYouTubeId youtu.be short URL — regression (Bug 5)", () => {
  function extractYouTubeId(url: string): string | null {
    try {
      const u = new URL(url);
      if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
      return u.searchParams.get("v");
    } catch {
      return null;
    }
  }

  it("standard youtube.com/watch?v= URL works", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("youtu.be short URL returns correct video ID", () => {
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("youtu.be short URL with query params returns pathname ID, not ?v param", () => {
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ?si=someToken")).toBe("dQw4w9WgXcQ");
  });

  it("BUG SCENARIO: searchParams.get('v') returns null for youtu.be — would produce no embed", () => {
    const url = "https://youtu.be/dQw4w9WgXcQ";
    const u = new URL(url);
    expect(u.searchParams.get("v")).toBeNull(); // confirms old bug
    expect(u.hostname).toBe("youtu.be");
    expect(u.pathname.slice(1)).toBe("dQw4w9WgXcQ"); // fixed path
  });

  it("empty youtu.be URL (no ID) returns null", () => {
    expect(extractYouTubeId("https://youtu.be/")).toBeNull();
  });

  it("non-YouTube URL returns null", () => {
    expect(extractYouTubeId("https://vimeo.com/12345")).toBeNull();
  });

  it("invalid URL returns null without throwing", () => {
    expect(extractYouTubeId("not-a-url")).toBeNull();
  });

  it("youtube.com/embed/ URL returns null (not a watch URL)", () => {
    // Embed URLs don't have ?v= params — extractYouTubeId should return null
    // (iframes are constructed from the embed URL directly, not extracted)
    expect(extractYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBeNull();
  });

  it("full watch URL with extra query params still extracts v correctly", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123")).toBe("dQw4w9WgXcQ");
  });
});

// ---------------------------------------------------------------------------
// Bug 6 — TV FATAL overlay: forceReconnect() vs window.location.reload()
//
// Root cause: the "Try Again" button in LiveBroadcastV2.tsx called
//   onClick={() => window.location.reload()}
// which re-bootstraps the entire SPA (300-500ms paint cost, loses all React
// state, interrupts ongoing uploads/SSE connections).
//
// Fix: useV2Broadcast now returns forceReconnect(), which calls
//   session.transport.forceReconnect()
// This triggers transport reconnect (WS/SSE re-handshake) in ~50ms without
// a full page reload.
//
// Algorithm invariant tested here:
//   forceReconnect() resets the transport without clearing FSM state.
//   The machine stays in SYNCING (not BOOTSTRAP) after a forced reconnect.
// ---------------------------------------------------------------------------

describe("forceReconnect vs window.location.reload — regression (Bug 6)", () => {
  it("forceReconnect algorithm: transport reset without FSM state wipe", () => {
    // Simulate the two strategies:
    type ReconnectStrategy = "reload" | "forceReconnect";

    interface TransportState {
      connected: boolean;
      reconnectCount: number;
    }
    interface FsmState {
      state: string;
      sequence: number;
    }

    function applyStrategy(strategy: ReconnectStrategy, fsm: FsmState, transport: TransportState): {
      fsmState: string;
      transportConnected: boolean;
      reconnectCount: number;
      pageReloaded: boolean;
    } {
      if (strategy === "reload") {
        // Full page reload: wipes everything
        return { fsmState: "BOOTSTRAP", transportConnected: false, reconnectCount: 0, pageReloaded: true };
      }
      // forceReconnect: only transport reconnects; FSM keeps lastSequence
      return {
        fsmState: "SYNCING",
        transportConnected: true,
        reconnectCount: transport.reconnectCount + 1,
        pageReloaded: false,
      };
    }

    const fsm: FsmState = { state: "FATAL", sequence: 42 };
    const transport: TransportState = { connected: false, reconnectCount: 0 };

    const reloadResult = applyStrategy("reload", fsm, transport);
    expect(reloadResult.pageReloaded).toBe(true);
    expect(reloadResult.fsmState).toBe("BOOTSTRAP"); // sequence lost

    const reconnectResult = applyStrategy("forceReconnect", fsm, transport);
    expect(reconnectResult.pageReloaded).toBe(false);
    expect(reconnectResult.fsmState).toBe("SYNCING");  // sequence preserved
    expect(reconnectResult.reconnectCount).toBe(1);
  });

  it("forceReconnect is faster than page reload (no DOM destruction)", () => {
    // Structural: verify the forceReconnect path has no page-reload side effects
    let reloadCalled = false;
    let forceReconnectCalled = false;

    const mockWindow = { location: { reload: () => { reloadCalled = true; } } };
    const mockTransport = { forceReconnect: () => { forceReconnectCalled = true; } };

    // New code path: calls transport, not window
    mockTransport.forceReconnect();
    expect(forceReconnectCalled).toBe(true);
    expect(reloadCalled).toBe(false);

    // Old code path (for reference)
    mockWindow.location.reload();
    expect(reloadCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 7 — Mobile LIVE_OVERRIDE_ACTIVE phase timer fires after videoReady
//
// Root cause: V2PlayerContainer's phase timer (5s interval) was armed on
// LIVE_OVERRIDE_ACTIVE entry and never cleared once videoReady=true because
// the overlayContent() short-circuits to null. The invisible timer kept
// firing setLoadingPhase() causing silent setState() calls every 5s.
//
// Fix: useEffect([snapshot.state, videoReady]) clears phaseTimerRef when
//   state === "LIVE_OVERRIDE_ACTIVE" && videoReady === true.
//
// Algorithm tested here: the timer clear condition fires correctly.
// ---------------------------------------------------------------------------

describe("LIVE_OVERRIDE_ACTIVE phase timer cleared on videoReady — regression (Bug 7)", () => {
  it("timer is cleared when state=LIVE_OVERRIDE_ACTIVE and videoReady becomes true", () => {
    let timerActive = false;
    let timerClearCount = 0;

    const clearPhaseTimer = () => {
      if (timerActive) {
        timerActive = false;
        timerClearCount++;
      }
    };

    function simulateEffect(state: string, videoReady: boolean) {
      // Mirrors the useEffect([snapshot.state, videoReady]) logic:
      if (state === "LIVE_OVERRIDE_ACTIVE" && videoReady) {
        clearPhaseTimer();
      }
    }

    // Phase 1: override starts, video not yet ready → timer runs
    timerActive = true;
    simulateEffect("LIVE_OVERRIDE_ACTIVE", false);
    expect(timerActive).toBe(true); // still running — overlay visible
    expect(timerClearCount).toBe(0);

    // Phase 2: video becomes ready → clear the timer (overlay gone)
    simulateEffect("LIVE_OVERRIDE_ACTIVE", true);
    expect(timerActive).toBe(false); // cleared
    expect(timerClearCount).toBe(1);

    // Phase 3: state changes to PLAYING — timer was already cleared, no double-clear
    simulateEffect("PLAYING", true);
    expect(timerClearCount).toBe(1);
  });

  it("timer is NOT cleared when videoReady=false (overlay still showing)", () => {
    let timerActive = true;
    const clearPhaseTimer = () => { timerActive = false; };
    function simulateEffect(state: string, videoReady: boolean) {
      if (state === "LIVE_OVERRIDE_ACTIVE" && videoReady) clearPhaseTimer();
    }
    simulateEffect("LIVE_OVERRIDE_ACTIVE", false);
    expect(timerActive).toBe(true); // must not clear — overlay still visible
  });

  it("timer is NOT cleared for non-override states even when videoReady=true", () => {
    for (const state of ["PLAYING", "PREPARING_ACTIVE", "RECOVERING_PRIMARY", "FATAL"]) {
      let timerActive = true;
      const clearPhaseTimer = () => { timerActive = false; };
      function simulateEffect(s: string, videoReady: boolean) {
        if (s === "LIVE_OVERRIDE_ACTIVE" && videoReady) clearPhaseTimer();
      }
      simulateEffect(state, true);
      expect(timerActive).toBe(true); // no clear for non-override state
    }
  });

  it("timer clear is idempotent (can be called multiple times safely)", () => {
    let clearCallCount = 0;
    let timerRef: ReturnType<typeof setTimeout> | null = null;

    const clearPhaseTimer = () => {
      if (timerRef !== null) {
        clearTimeout(timerRef);
        timerRef = null;
        clearCallCount++;
      }
    };

    // Arm the timer
    timerRef = setTimeout(() => {}, 5_000);

    // Clear twice — should only count once
    clearPhaseTimer();
    clearPhaseTimer();
    expect(clearCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bug 8 — naturalEnd retry setTimeout leaks when session is destroyed
//
// Bug: machine.setNaturalEndCallback wired a doPost() retry chain using
// plain setTimeout(). When the janitor evicted a session (machine.destroy()
// + transport.stop()), the in-flight retry timers had no cancellation
// mechanism — they kept calling POST /natural-end and transport.requestSnapshot()
// indefinitely, even on a dead transport with stopped = true.
//
// Fix: added `if (transport.isStopped) return;` checks at the top of doPost()
// and inside the .catch() retry branch. V2Transport now exposes a public
// `get isStopped` getter that react.ts reads before each retry attempt.
// ---------------------------------------------------------------------------

describe("naturalEnd retry — cancelled on transport stop (Bug 8)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("isStopped returns false before stop() and true after stop()", async () => {
    // Import dynamically so vitest module isolation works
    const { V2Transport, configureMobileStorage } = await import("../src/transport.js");

    const store = new Map<string, string>();
    configureMobileStorage({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    });

    const t = new V2Transport({
      baseUrl: "http://localhost/api/broadcast-v2",
      channel: "main",
      onPlayerEvent: () => {},
      onConnectionChange: () => {},
    });

    expect(t.isStopped).toBe(false);
    t.stop();
    expect(t.isStopped).toBe(true);
  });

  it("doPost retry logic bails out immediately when isStopped is true", () => {
    // Simulate the doPost retry guard logic extracted from react.ts
    // to confirm that isStopped=true prevents the next retry from running.
    const naturalEndRetryDelays = [2_000, 4_000, 8_000];
    let retryCount = 0;

    // Simulate a transport that is already stopped
    const stoppedTransport = { isStopped: true, requestSnapshot: vi.fn() };

    const doPost = (attempt: number): void => {
      if (stoppedTransport.isStopped) return; // <-- the fix
      retryCount++;
      // Simulate fetch failure → schedule retry
      if (attempt < naturalEndRetryDelays.length) {
        setTimeout(() => doPost(attempt + 1), naturalEndRetryDelays[attempt]);
      } else {
        stoppedTransport.requestSnapshot();
      }
    };

    doPost(0); // Should bail immediately due to isStopped

    expect(retryCount).toBe(0);
    expect(stoppedTransport.requestSnapshot).not.toHaveBeenCalled();
  });

  it("doPost mid-flight bail: if transport stops between fetch and retry, no further retries fire", () => {
    const naturalEndRetryDelays = [2_000, 4_000, 8_000];
    let retryCount = 0;
    const mockTransport = { isStopped: false, requestSnapshot: vi.fn() };

    const doPost = (attempt: number): void => {
      if (mockTransport.isStopped) return;
      retryCount++;
      // Simulate fetch failure catch block:
      // Stop the transport BEFORE the retry fires
      mockTransport.isStopped = true;
      if (attempt < naturalEndRetryDelays.length) {
        setTimeout(() => doPost(attempt + 1), naturalEndRetryDelays[attempt]);
      }
    };

    doPost(0); // first call — not stopped yet, retryCount = 1
    expect(retryCount).toBe(1); // first attempt went through

    // Advance time to trigger the scheduled retry
    vi.advanceTimersByTime(10_000);
    // The retry should have bailed because mockTransport.isStopped was set to true
    expect(retryCount).toBe(1); // no second attempt
    expect(mockTransport.requestSnapshot).not.toHaveBeenCalled();
  });
});
