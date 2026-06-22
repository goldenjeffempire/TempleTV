/**
 * Shared 15-second heartbeat timer.
 *
 * Replaces N independent `setInterval` calls with a single JS timer, reducing
 * the number of timer wake-ups — especially important on iOS where background
 * timer coalescing is strict and each extra interval can prevent CPU idle-sleep.
 *
 * Each subscriber registers a callback and a desired period. The scheduler
 * rounds the period to the nearest multiple of BASE_TICK_MS (15 s) and fires
 * the callback every N ticks where `N = round(intervalMs / BASE_TICK_MS)`.
 *
 * The shared interval self-stops when all subscribers have unsubscribed, and
 * restarts automatically when a new subscriber registers. This means the
 * module has zero cost when nothing is using it.
 *
 * Usage:
 * ```ts
 * const stop = scheduleHeartbeat(() => runMyCheck(), 30_000);
 * // later:
 * stop(); // safe to call from inside the callback (re-entrant)
 * ```
 */

/** Shared base tick period (ms). GCD of 15 s, 30 s, 60 s. */
export const HEARTBEAT_BASE_MS = 15_000;

interface Sub {
  callback: () => void;
  tickInterval: number;
  counter: number;
}

// Module-level singletons — shared across all callers in the same JS runtime.
const subs: Sub[] = [];
let handle: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  // Snapshot before iterating so callbacks can safely call their own unsubscribe
  // (which splices `subs`) without corrupting the current iteration.
  const snapshot = subs.slice();
  for (const sub of snapshot) {
    if (!subs.includes(sub)) continue; // already removed mid-tick
    sub.counter++;
    if (sub.counter >= sub.tickInterval) {
      sub.counter = 0;
      try {
        sub.callback();
      } catch {
        // swallow — each subscriber is independent
      }
    }
  }
  // Auto-stop the shared timer when the last subscriber has left.
  if (subs.length === 0 && handle !== null) {
    clearInterval(handle);
    handle = null;
  }
}

function ensureTimer(): void {
  if (handle !== null || typeof setInterval === "undefined") return;
  handle = setInterval(tick, HEARTBEAT_BASE_MS);
  // Allow Node.js / Hermes to exit even when the interval is live.
  (handle as unknown as { unref?: () => void }).unref?.();
}

/**
 * Register a periodic callback.
 *
 * @param callback   Called every `intervalMs` ms (rounded to nearest 15 s).
 *                   Errors are swallowed. Safe to call `unsubscribe` from here.
 * @param intervalMs Desired period. Rounded to the nearest tick multiple (≥ 15 s).
 * @param eager      When `true` the first call fires on the very next tick
 *                   (~15 s) instead of after the full `intervalMs` period.
 *                   Default: `false`.
 * @returns          Unsubscribe function. Idempotent and re-entrant-safe.
 */
export function scheduleHeartbeat(
  callback: () => void,
  intervalMs: number,
  eager = false,
): () => void {
  const tickInterval = Math.max(1, Math.round(intervalMs / HEARTBEAT_BASE_MS));
  const sub: Sub = {
    callback,
    tickInterval,
    // eager=true → counter starts at tickInterval-1 so next tick fires callback.
    // eager=false → counter starts at 0 so callback fires after the full period.
    counter: eager ? tickInterval - 1 : 0,
  };
  subs.push(sub);
  ensureTimer();

  let removed = false;
  return function unsubscribe(): void {
    if (removed) return;
    removed = true;
    const idx = subs.indexOf(sub);
    if (idx !== -1) subs.splice(idx, 1);
    if (subs.length === 0 && handle !== null) {
      clearInterval(handle);
      handle = null;
    }
  };
}
