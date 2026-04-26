import { useEffect, useState } from "react";
import type { BroadcastCurrent, LiveStatus } from "../lib/api";

/**
 * NOW ON AIR + UP NEXT strip — shown above the cinematic hero on the TV
 * homepage. Mirrors the channel-bug strip on cable boxes (e.g. ESPN's
 * "next up" ticker) so viewers always see what's airing right now and
 * what's coming next, even if they don't navigate into the hero.
 *
 * Truth source order:
 *   1. YouTube live event   → "ON AIR" with live program title
 *   2. Broadcast queue item → "ON AIR" with current program + UP NEXT
 *   3. Idle                 → strip is hidden (no fake content)
 */
interface BroadcastOnAirStripProps {
  liveStatus: LiveStatus | null;
  broadcastCurrent: BroadcastCurrent | null;
}

function formatProgress(positionSecs: number, totalSecs: number): string {
  if (totalSecs <= 0) return "";
  const remain = Math.max(0, totalSecs - positionSecs);
  const m = Math.floor(remain / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m left`;
  }
  if (m >= 1) return `${m} min left`;
  return "ending shortly";
}

function LivePulse() {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 10, height: 10 }}>
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: "#fff",
          opacity: 0.6,
          animation: "tv-strip-pulse 1.4s ease-out infinite",
        }}
      />
      <span
        style={{
          position: "relative",
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "#fff",
        }}
      />
    </span>
  );
}

export function BroadcastOnAirStrip({ liveStatus, broadcastCurrent }: BroadcastOnAirStripProps) {
  const isYouTubeLive = liveStatus?.isLive ?? false;
  const item = broadcastCurrent?.item ?? null;
  const nextItem = broadcastCurrent?.nextItem ?? null;

  const [livePosition, setLivePosition] = useState(broadcastCurrent?.positionSecs ?? 0);

  // Drift-correct the position so the "X min left" countdown ticks down
  // smoothly between fetches without re-rendering the parent.
  useEffect(() => {
    if (!broadcastCurrent?.item || isYouTubeLive) return;
    const baseline = broadcastCurrent.positionSecs;
    const baselineMs = broadcastCurrent.serverTimeMs;
    const tick = () => {
      const drift = (Date.now() - baselineMs) / 1000;
      setLivePosition(baseline + drift);
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, [broadcastCurrent?.item?.id, broadcastCurrent?.positionSecs, broadcastCurrent?.serverTimeMs, isYouTubeLive]);

  // Hide entirely when there's nothing to show — never display fake content.
  if (!isYouTubeLive && !item) return null;

  const onAirTitle = isYouTubeLive
    ? (liveStatus?.title || broadcastCurrent?.liveOverride?.title || "Temple TV Live")
    : (item?.title ?? "Temple TV");

  const totalSecs = item?.durationSecs ?? 0;
  const remaining = !isYouTubeLive && totalSecs > 0 ? formatProgress(livePosition, totalSecs) : "";

  return (
    <>
      <style>{`
        @keyframes tv-strip-pulse {
          0% { transform: scale(1); opacity: 0.6; }
          70% { transform: scale(2.4); opacity: 0; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
      <div
        data-testid="broadcast-onair-strip"
        style={{
          position: "absolute",
          top: 96,
          left: "var(--tv-safe-h, 60px)",
          right: "var(--tv-safe-h, 60px)",
          zIndex: 15,
          display: "flex",
          alignItems: "stretch",
          gap: 14,
          padding: "10px 18px",
          borderRadius: 14,
          background: "linear-gradient(90deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.55) 100%)",
          border: "1px solid rgba(255,255,255,0.08)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
          pointerEvents: "none",
          fontFamily: "inherit",
        }}
      >
        {/* NOW ON AIR */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 auto" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              borderRadius: 8,
              background: isYouTubeLive ? "#dc2626" : "#9333ea",
              color: "#fff",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              flex: "0 0 auto",
              boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
            }}
          >
            <LivePulse />
            {isYouTubeLive ? "Live Now" : "On Air"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2 }}>
            <div
              style={{
                color: "rgba(255,255,255,0.55)",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              Now Playing
            </div>
            <div
              style={{
                color: "#fff",
                fontSize: 17,
                fontWeight: 700,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                lineHeight: 1.2,
              }}
              title={onAirTitle}
            >
              {onAirTitle}
            </div>
          </div>
          {remaining && (
            <div
              style={{
                marginLeft: "auto",
                fontSize: 12,
                color: "rgba(255,255,255,0.65)",
                fontWeight: 600,
                whiteSpace: "nowrap",
                paddingLeft: 12,
              }}
            >
              {remaining}
            </div>
          )}
        </div>

        {/* UP NEXT — only when we know what's coming next */}
        {nextItem && (
          <>
            <div
              style={{
                width: 1,
                background: "linear-gradient(180deg, transparent, rgba(255,255,255,0.2), transparent)",
                flex: "0 0 auto",
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minWidth: 0,
                flex: "1 1 auto",
                maxWidth: "42%",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "6px 12px",
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  color: "rgba(255,255,255,0.92)",
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  flex: "0 0 auto",
                }}
              >
                Up Next
              </div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2 }}>
                <div
                  style={{
                    color: "rgba(255,255,255,0.55)",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  Coming Up
                </div>
                <div
                  style={{
                    color: "rgba(255,255,255,0.92)",
                    fontSize: 15,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    lineHeight: 1.2,
                  }}
                  title={nextItem.title}
                >
                  {nextItem.title}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
