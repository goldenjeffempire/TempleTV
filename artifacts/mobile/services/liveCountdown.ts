import { useEffect, useState } from "react";

/**
 * Mobile twin of `artifacts/tv/src/lib/liveCountdown.ts`. See that file for
 * the design rationale (server-time alignment, MAX_VISIBLE_WINDOW_MS, etc.)
 * — kept as a separate file rather than shared because the mobile bundle
 * deliberately avoids importing from the TV workspace.
 */
const MAX_VISIBLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LiveCountdown {
  label: string;
  msUntilStart: number;
  imminent: boolean;
}

export function useLiveCountdown(
  startTime: string | null | undefined,
  serverTimeMs: number | null | undefined,
): LiveCountdown | null {
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
