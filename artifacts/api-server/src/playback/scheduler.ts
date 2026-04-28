/**
 * Playback transition scheduler.
 *
 * Watches the current item's `endsAtMs` and emits a coordinated sequence of
 * events that drive the dual-buffer client engine:
 *
 *   T-15s → "preload" hint (lead=15000)  — client attaches next source on
 *                                           the preload surface
 *   T-10s → "preload" hint (lead=10000)  — client confirms HLS manifest
 *                                           parsed, primes initial segments
 *    T-5s → "preload" hint (lead=5000)   — client confirms first segment
 *                                           buffered
 *    T-0  → "state" event (reason=transition) — client opacity-swaps
 *                                                preload→active in <50ms
 *
 * All timers are derived from the authoritative `endsAtMs` on the resolved
 * `current` PlaybackItem (so the scheduler can never get out of sync with
 * the actual lineup). Whenever the lineup changes (queue mutation, override
 * start/stop), `rearm()` is called to cancel and re-derive every timer.
 *
 * Capped at PRECISION_TIMER_MAX_MS (24h) so a long-form item never schedules
 * a setTimeout outside Node's safe range — a periodic 60s safety tick
 * re-arms whenever we get inside the cap.
 */

import { logger } from "../lib/logger";
import { getPlaybackBus } from "./eventBus";
import { buildPlaybackState, invalidatePlaybackState } from "./playbackEngine";

const PRECISION_TIMER_MAX_MS = 24 * 60 * 60 * 1000;
const SAFETY_TICK_MS = 60_000;

const LEADS_MS = [15_000, 10_000, 5_000] as const;

type Handle = ReturnType<typeof setTimeout>;

const handles: Handle[] = [];
let safetyTick: Handle | null = null;
let started = false;
let currentEndsAtMs: number | null = null;

function clearTimers(): void {
  for (const h of handles) clearTimeout(h);
  handles.length = 0;
}

async function emitState(reason: "transition") {
  invalidatePlaybackState();
  try {
    const state = await buildPlaybackState(true);
    getPlaybackBus().publish({ type: "state", reason, state });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "playback.scheduler.emitState failed",
    );
  }
}

async function emitPreload(leadMs: 15000 | 10000 | 5000) {
  try {
    const state = await buildPlaybackState();
    getPlaybackBus().publish({ type: "preload", leadMs, state });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), leadMs },
      "playback.scheduler.emitPreload failed",
    );
  }
}

/**
 * Re-derive the timer set from the current PlaybackState. Idempotent:
 * cancels any pending timers first. Safe to call from any listener that
 * mutates the lineup.
 */
export async function rearm(): Promise<void> {
  if (!started) return;
  clearTimers();

  const state = await buildPlaybackState(true);
  const endsAtMs = state.current?.endsAtMs ?? null;
  currentEndsAtMs = endsAtMs;
  if (endsAtMs == null) return;

  const now = Date.now();
  const swapInMs = endsAtMs - now;

  // The `current` item already ended; kick a transition right away so the
  // engine catches up (the resolver will pick the new on-air item).
  if (swapInMs <= 0) {
    queueMicrotask(() => {
      emitState("transition").catch(() => {});
    });
    return;
  }

  // Schedule preload hints for any leads we still have time to honour.
  for (const lead of LEADS_MS) {
    const at = swapInMs - lead;
    if (at <= 0) continue;
    if (at > PRECISION_TIMER_MAX_MS) continue;
    const h = setTimeout(() => {
      emitPreload(lead).catch(() => {});
    }, at);
    h.unref();
    handles.push(h);
  }

  // Schedule the actual swap. If it's beyond the safe range, the safety
  // tick will rearm us as we get closer.
  if (swapInMs <= PRECISION_TIMER_MAX_MS) {
    const h = setTimeout(() => {
      emitState("transition")
        .then(() => rearm())
        .catch(() => {});
    }, swapInMs);
    h.unref();
    handles.push(h);
  }
}

/**
 * Start the scheduler. Idempotent — safe to call multiple times.
 * Mounts a 60s safety-tick that re-arms whenever the current item changes
 * out from under us (e.g. the broadcast transition ticker advanced the
 * anchor without telling us via an explicit `rearm()`).
 */
export function startPlaybackScheduler(): void {
  if (started) return;
  started = true;
  rearm().catch(() => {});

  safetyTick = setInterval(() => {
    buildPlaybackState()
      .then((state) => {
        const endsAtMs = state.current?.endsAtMs ?? null;
        if (endsAtMs !== currentEndsAtMs) {
          rearm().catch(() => {});
        }
      })
      .catch(() => {});
  }, SAFETY_TICK_MS);
  safetyTick.unref();

  logger.info(
    { leadsMs: LEADS_MS, safetyTickMs: SAFETY_TICK_MS },
    "Playback scheduler started",
  );
}

export function stopPlaybackScheduler(): void {
  started = false;
  clearTimers();
  if (safetyTick) {
    clearInterval(safetyTick);
    safetyTick = null;
  }
}
