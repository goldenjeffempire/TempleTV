import { useEffect, useState } from "react";

/**
 * Server-time-aware countdown to a scheduled live broadcast.
 *
 * Why server-time-aware: TV web views can run on devices with badly drifted
 * clocks (set-top boxes that haven't synced NTP for weeks). The broadcast
 * payload exposes `serverTimeMs`, so we compute a single offset at mount
 * and apply it to every tick instead of trusting `Date.now()` directly.
 *
 * Returns `null` when the start time is missing, in the past, or further
 * than `MAX_VISIBLE_WINDOW_MS` away — callers should hide the countdown
 * pill in those cases.
 */
const MAX_VISIBLE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export interface LiveCountdown {
  /** Human-readable label, e.g. "Starts in 4m 12s" or "Starting any moment". */
  label: string;
  /** ms until start, clamped at 0. Useful for animations / urgency tone. */
  msUntilStart: number;
  /** True when within the final 60 s — UI can pulse the pill. */
  imminent: boolean;
}

export function useLiveCountdown(
  startTime: string | null | undefined,
  serverTimeMs: number | null | undefined,
): LiveCountdown | null {
  // Capture the server/client offset once per startTime change. After that,
  // every tick uses the local clock + offset, so we don't depend on the
  // payload re-fetching to keep counting down.
  const [offsetMs] = useState<number>(() =>
    typeof serverTimeMs === "number" ? serverTimeMs - Date.now() : 0,
  );
  const [now, setNow] = useState(() => Date.now() + offsetMs);

  useEffect(() => {
    if (!startTime) return;
    const id = setInterval(() => setNow(Date.now() + offsetMs), 1000);
    return () => clearInterval(id);
  }, [startTime, offsetMs]);

  if (!startTime) return null;
  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs)) return null;
  const delta = startMs - now;
  if (delta <= 0) {
    // Already past start — caller should be showing the live state instead;
    // surface a "starting any moment" so the brief gap before SSE flips
    // `isLive` true doesn't show a stale countdown.
    return { label: "Starting any moment", msUntilStart: 0, imminent: true };
  }
  if (delta > MAX_VISIBLE_WINDOW_MS) return null;
  return {
    label: `Starts in ${formatDelta(delta)}`,
    msUntilStart: delta,
    imminent: delta <= 60_000,
  };
}

function formatDelta(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  return `${secs}s`;
}
