import { useEffect, useRef } from "react";

/**
 * Visibility-aware polling primitive.
 *
 * The admin dashboard has many long-lived dashboards (Operations, Transcoding,
 * Live Monitor, etc.) that operators routinely leave open in background tabs
 * for hours at a time. Each of those tabs polls a heavy backend endpoint
 * (`/api/admin/ops/status` runs four COUNT queries per call; the transcoding
 * queue is similar) every few seconds. With 5–10 operators each leaving 3–4
 * tabs open, the API ends up serving thousands of admin requests per minute
 * for screens nobody is actually looking at.
 *
 * This hook fixes that with two layered guarantees:
 *
 *   1. **Visibility gating.** The polling timer only runs while the document
 *      is visible. As soon as the tab is hidden (browser minimized, tab
 *      switched away, OS sleep), the timer is cleared. When the tab becomes
 *      visible again, the callback fires immediately (so the operator sees
 *      fresh data the moment they return) and the timer restarts.
 *
 *   2. **Initial fire on mount.** Mounts call the callback once immediately
 *      so the page never starts blank — same UX as the manual
 *      `setInterval` + initial `load()` pattern these call sites used to use.
 *
 * The callback is held in a ref so a parent component re-render doesn't
 * cancel and re-arm the timer (the standard React-stale-closure tax that
 * `setInterval` patterns pay if you put `callback` in the deps array). This
 * matches the behaviour of the official React docs' "useInterval" pattern.
 *
 * Pass `intervalMs = null` to disable polling entirely (useful for
 * conditional polling, e.g. "only poll while the user is on this tab").
 */
export function usePollingWhenVisible(
  callback: () => void | Promise<void>,
  intervalMs: number | null,
): void {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (intervalMs == null || intervalMs <= 0) return;

    let timerId: number | null = null;

    const fire = () => {
      // Swallow rejected promises here — every caller already has its own
      // try/catch that updates an `error` state. We must never let an
      // unhandled rejection escape this hook.
      try {
        const ret = savedCallback.current();
        if (ret && typeof (ret as Promise<unknown>).catch === "function") {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Synchronous throw: same logic — caller owns its own surfacing.
      }
    };

    const start = () => {
      if (timerId != null) return;
      timerId = window.setInterval(fire, intervalMs);
    };

    const stop = () => {
      if (timerId == null) return;
      window.clearInterval(timerId);
      timerId = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Fire immediately on tab return so the operator never sees stale
        // data while the next interval ticks down. Without this, returning
        // to a tab after 30 minutes would still show 30-minute-old data
        // until the *next* interval tick.
        fire();
        start();
      } else {
        stop();
      }
    };

    // Mount-time: always fire immediately, then start the timer if visible.
    fire();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
}
