/**
 * Adaptive stall watchdog.
 *
 * Uses a 3-phase threshold model rather than a single fixed timeout:
 *
 *  Phase 1 — INITIAL_LOAD (arm → first advance): generous window for the
 *    initial manifest + first-segment download.  HLS cold-start on a slow
 *    mobile link can easily take 12–18 s before `currentTime` first moves.
 *    A 15 s flat threshold triggers false-positive stalls during this phase
 *    and causes perfectly good content to be skipped.
 *
 *  Phase 2 — REBUFFER (advance seen, then stalls again): mid-stream rebuffer
 *    after the first advance.  The buffer was healthy once so the source is
 *    known-good; give it a full 15 s to refill before escalating.
 *
 *  Phase 3 — STABLE (played continuously for ≥ STABLE_PLAY_MS): long-running
 *    stable streams (live, 2-hour sermons) should not be interrupted by a
 *    brief 1–2 s network hiccup.  25 s threshold keeps the broadcast alive
 *    through momentary CDN cache-miss pauses.
 *
 * All three thresholds are overridable via WatchdogConfig so tests and
 * callers can tune them without rebuilding.
 */

export interface WatchdogConfig {
  /**
   * Threshold for Phase 1: initial load (before any timeupdate progress).
   * @default 15_000
   */
  initialLoadThresholdMs?: number;
  /**
   * Threshold for Phase 2: mid-stream rebuffer (after first advance).
   * @default 15_000
   */
  rebufferThresholdMs?: number;
  /**
   * Threshold for Phase 3: stable playback (played continuously for
   * ≥ stablePlayMs).
   * @default 25_000
   */
  stableThresholdMs?: number;
  /**
   * How long currentTime must have been advancing before a stall is
   * treated as "stable playback" rather than "rebuffer".
   * @default 30_000
   */
  stablePlayMs?: number;
  /**
   * Called when a stall is detected.  Fired at most once per stall event;
   * the clock is reset afterward so the next check cycle starts fresh.
   */
  onStall: () => void;
}

type WatchdogPhase = "initial" | "rebuffer" | "stable";

export class Watchdog {
  private lastPositionSecs = 0;
  private lastAdvanceMs = Date.now();
  /** Wall-clock ms when the first timeupdate advance was seen. */
  private firstAdvanceMs: number | null = null;
  /** Wall-clock ms when we last entered "stable" continuous play. */
  private stableEnteredMs: number | null = null;
  private armed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly initialLoadThresholdMs: number;
  private readonly rebufferThresholdMs: number;
  private readonly stableThresholdMs: number;
  private readonly stablePlayMs: number;

  constructor(private readonly cfg: WatchdogConfig) {
    this.initialLoadThresholdMs = cfg.initialLoadThresholdMs ?? 15_000;
    this.rebufferThresholdMs    = cfg.rebufferThresholdMs    ?? 15_000;
    this.stableThresholdMs      = cfg.stableThresholdMs      ?? 25_000;
    this.stablePlayMs           = cfg.stablePlayMs           ?? 30_000;
  }

  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.lastAdvanceMs = Date.now();
    this.firstAdvanceMs = null;
    this.stableEnteredMs = null;
    this.timer = setInterval(() => this.check(), 500);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  disarm(): void {
    this.armed = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.firstAdvanceMs = null;
    this.stableEnteredMs = null;
  }

  /** Caller must invoke this on every `timeupdate` / equivalent event. */
  feed(positionSecs: number): void {
    if (!this.armed) return;
    if (Math.abs(positionSecs - this.lastPositionSecs) > 0.05) {
      this.lastPositionSecs = positionSecs;
      const now = Date.now();
      this.lastAdvanceMs = now;

      if (this.firstAdvanceMs === null) {
        // First real progress — leave initial phase and start stable timer.
        this.firstAdvanceMs = now;
        this.stableEnteredMs = now;
      }
      // Do NOT reset stableEnteredMs on subsequent advances.
      // stableEnteredMs is intentionally kept at the value from the first
      // advance (or the last notifyActive / disarm reset). This allows
      // resolvePhase() to detect 30 s of uninterrupted play and switch to
      // the "stable" threshold (25 s) — giving a long-running stream more
      // tolerance before a stall is declared.
      //
      // Previous code reset stableEnteredMs to `now` on every advance,
      // meaning Date.now() - stableEnteredMs was always ≈ 0 and the
      // "stable" phase was never reached (rebuffer 15 s threshold always
      // applied, even on streams playing for hours without interruption).
    }
  }

  /**
   * Signal that data is actively flowing even though `currentTime` has not
   * advanced yet (e.g. the browser is downloading/decoding a new segment
   * mid-rebuffer, or a seek is in progress).
   *
   * Resets the stall clock WITHOUT updating `lastPositionSecs`, so the
   * next real `timeupdate` advance is still required to confirm playback.
   * This prevents false-positive stall recovery during legitimate rebuffer
   * pauses on slow connections, while still detecting truly frozen sources
   * that never recover.
   *
   * Also resets stableEnteredMs so a brief rebuffer doesn't count as
   * "stable" time — the device must re-earn the stable threshold.
   */
  notifyActive(): void {
    if (!this.armed) return;
    const now = Date.now();
    this.lastAdvanceMs = now;
    // Rebuffering — reset stable window so a brief pause can't silently
    // accumulate toward the stable threshold.
    if (this.stableEnteredMs !== null) {
      this.stableEnteredMs = now;
    }
  }

  /** Expose current phase for diagnostics / tests. */
  getPhase(): WatchdogPhase {
    return this.resolvePhase();
  }

  /** Expose current threshold for diagnostics / tests. */
  getCurrentThresholdMs(): number {
    return this.thresholdForPhase(this.resolvePhase());
  }

  private resolvePhase(): WatchdogPhase {
    if (this.firstAdvanceMs === null) return "initial";
    if (
      this.stableEnteredMs !== null &&
      Date.now() - this.stableEnteredMs >= this.stablePlayMs
    ) {
      return "stable";
    }
    return "rebuffer";
  }

  private thresholdForPhase(phase: WatchdogPhase): number {
    switch (phase) {
      case "initial":  return this.initialLoadThresholdMs;
      case "rebuffer": return this.rebufferThresholdMs;
      case "stable":   return this.stableThresholdMs;
    }
  }

  private check(): void {
    if (!this.armed) return;
    const threshold = this.thresholdForPhase(this.resolvePhase());
    if (Date.now() - this.lastAdvanceMs > threshold) {
      this.cfg.onStall();
      // Reset clock so the same stall doesn't refire every 500 ms.
      // Also reset stable tracking so a recovered stream re-earns stability.
      const now = Date.now();
      this.lastAdvanceMs = now;
      this.stableEnteredMs = now;
    }
  }
}
