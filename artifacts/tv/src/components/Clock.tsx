import { useEffect, useState } from "react";

/**
 * Wall-clock display for the TV header.
 *
 * Accepts an optional `offsetMs` (default 0) computed by the caller as
 * `Date.now() - serverTimeMs` from the latest broadcast snapshot. This
 * corrects for TV devices whose local system clock is significantly wrong
 * (common on hospitality TVs and older Smart TV firmware).
 */
export function Clock({ offsetMs = 0 }: { offsetMs?: number }) {
  const [time, setTime] = useState(() => new Date(Date.now() + offsetMs));

  useEffect(() => {
    const id = setInterval(() => setTime(new Date(Date.now() + offsetMs)), 1000);
    return () => clearInterval(id);
  }, [offsetMs]);

  const hours = time.getHours();
  const minutes = time.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const h = hours % 12 || 12;
  const m = String(minutes).padStart(2, "0");

  return (
    <span className="text-white/70" style={{ fontSize: 22, fontWeight: 500, letterSpacing: "0.02em" }}>
      {h}:{m} {ampm}
    </span>
  );
}
