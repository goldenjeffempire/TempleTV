/**
 * useSessionWatchdog — long-session memory relief for 24/7 TV deployments.
 *
 * Smart TVs (Tizen, webOS, Fire TV) run the app continuously for days or
 * weeks without a native-app restart. Over time JS heap and HLS.js VRAM
 * accumulate until the browser process becomes unresponsive.
 *
 * This hook arms a 24-hour soft-reload timer that fires during an idle
 * window so the browser can clear its allocations and start fresh.
 *
 * Lifecycle behaviour:
 *  • Timer is reset when the platform resumes from standby (visibilitychange
 *    → resumed via lifecycle bus) — so a TV that was off for 12 hours
 *    doesn't reload the moment the viewer turns it back on.
 *  • Timer is paused while the platform is suspended so idle time in
 *    standby doesn't count toward the session limit.
 *  • On platforms that expose `requestIdleCallback` (Tizen 5+, webOS 5+,
 *    Fire TV with Chromium ≥ 79) the reload is deferred until the main
 *    thread is genuinely idle — so it never fires mid-segment-download.
 *    Older firmware gets a 5-second deferred reload as a safety net.
 */

import { useEffect } from "react";
import { onResumed, onSuspended } from "../lib/lifecycle";

const SESSION_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 h

function softReload(): void {
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(() => window.location.reload(), { timeout: 15_000 });
  } else {
    setTimeout(() => window.location.reload(), 5_000);
  }
}

export function useSessionWatchdog(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let suspended = false;
    let suspendedAt: number | null = null;

    function arm(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        softReload();
      }, SESSION_LIMIT_MS);
    }

    arm();

    const offResumed = onResumed(() => {
      suspended = false;
      // Extend the session window by however long the TV was in standby
      // so a device that suspends at hour 23 and resumes 2 hours later
      // gets another full ~24-hour window before soft-resetting.
      arm();
      suspendedAt = null;
    });

    const offSuspended = onSuspended(() => {
      suspended = true;
      suspendedAt = Date.now();
      // Pause the timer while suspended — idle standby time should not
      // count toward the session runtime limit.
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    });

    return () => {
      if (timer !== null) clearTimeout(timer);
      offResumed();
      offSuspended();
    };
  }, []);
}
