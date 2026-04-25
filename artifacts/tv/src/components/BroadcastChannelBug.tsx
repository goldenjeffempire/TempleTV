import { useEffect, useState } from "react";

/**
 * Real-broadcaster channel bug for the TV web surface.
 *
 * A discreet bottom-right station identifier that fades in 3 seconds after
 * each program change — the convention used by real TV networks (NBC,
 * ESPN, CNN) where the bug appears once the new program has settled on
 * screen, not the moment the cut happens. Pass the current program
 * identifier as `programKey` (e.g. the active HLS URL or videoId) — when
 * it changes, the bug fades back out and re-fades in after the 3s grace.
 *
 * The bug is rendered with `pointer-events: none` so it never intercepts
 * remote-control focus or click-to-play on the underlying video. It sits
 * at z-index 5, below the controls overlay (z-index 10) so the back
 * button + quality badge always win when the user wakes the chrome.
 */
interface BroadcastChannelBugProps {
  programKey?: string;
  /** Delay before the watermark fades in after a program change. Default 3000ms. */
  appearDelayMs?: number;
}

export function BroadcastChannelBug({
  programKey,
  appearDelayMs = 3000,
}: BroadcastChannelBugProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const t = setTimeout(() => setVisible(true), appearDelayMs);
    return () => clearTimeout(t);
  }, [programKey, appearDelayMs]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        right: "calc(env(safe-area-inset-right, 0px) + clamp(16px, 2.4vw, 28px))",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + clamp(16px, 2.4vw, 28px))",
        display: "flex",
        alignItems: "center",
        gap: "clamp(6px, 0.8vw, 10px)",
        padding: "clamp(6px, 1vw, 10px) clamp(10px, 1.6vw, 14px)",
        background: "rgba(0,0,0,0.42)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 8,
        opacity: visible ? 0.7 : 0,
        transition: "opacity 700ms ease-out",
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      <span
        style={{
          width: "clamp(6px, 0.7vw, 8px)",
          height: "clamp(6px, 0.7vw, 8px)",
          borderRadius: 999,
          background: "#FF0040",
          boxShadow: "0 0 6px rgba(255,0,64,0.7)",
        }}
      />
      <span
        style={{
          color: "#fff",
          fontSize: "clamp(10px, 1.05vw, 13px)",
          fontWeight: 700,
          letterSpacing: "0.14em",
          textShadow: "0 1px 6px rgba(0,0,0,0.6)",
        }}
      >
        TEMPLE TV
      </span>
    </div>
  );
}
