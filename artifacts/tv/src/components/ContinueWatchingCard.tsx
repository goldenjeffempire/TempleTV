/**
 * ContinueWatchingCard — TV 10-foot Continue Watching item
 * Shows thumbnail, title, progress bar, and time-remaining.
 */

import React, { useEffect, useRef } from "react";
import type { WatchHistoryEntry } from "../hooks/useWatchHistory";

const CARD_W = 348;
const CARD_H = 196;

interface Props {
  entry: WatchHistoryEntry;
  focused: boolean;
  onFocus: () => void;
  onClick: () => void;
}

function fmtRemaining(positionSecs: number, durationSecs: number): string {
  const remaining = Math.max(0, durationSecs - positionSecs);
  if (remaining < 60) return `${Math.round(remaining)}s left`;
  const m = Math.round(remaining / 60);
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m left` : `${h}h left`;
}

export const ContinueWatchingCard = React.memo(function ContinueWatchingCard({
  entry,
  focused,
  onFocus,
  onClick,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }, [focused]);

  const pct = Math.min(100, entry.progressPct);
  const hasTime = entry.durationSecs > 0;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="button"
      aria-label={`Continue watching ${entry.title}`}
      className={`tv-card flex-shrink-0 relative rounded-xl overflow-hidden cursor-pointer ${focused ? "tv-focused" : ""}`}
      style={{
        width: CARD_W,
        height: CARD_H,
        background: "#1a1a1a",
        borderRadius: 14,
        display: "flex",
        flexDirection: "column",
      }}
      onFocus={onFocus}
      onClick={onClick}
    >
      {/* Thumbnail */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {entry.thumbnailUrl ? (
          <img
            src={entry.thumbnailUrl}
            alt={entry.title}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            loading="lazy"
          />
        ) : (
          <div style={{ width: "100%", height: "100%", background: "rgba(106,13,173,0.2)" }} />
        )}

        {/* Dark vignette */}
        <div className="gradient-bottom absolute inset-0" />

        {/* Title + time overlay */}
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "10px 14px" }}>
          <p
            className="line-clamp-2 text-white"
            style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.3, marginBottom: 2 }}
          >
            {entry.title}
          </p>
          {hasTime && (
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 500 }}>
              {fmtRemaining(entry.positionSecs, entry.durationSecs)}
            </p>
          )}
        </div>

        {/* Focused play overlay */}
        {focused && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.28)" }}
          >
            <div
              className="flex items-center justify-center rounded-full"
              style={{
                width: 62,
                height: 62,
                background: "rgba(255,255,255,0.18)",
                backdropFilter: "blur(6px)",
                border: "2px solid rgba(255,255,255,0.35)",
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 4,
          background: "rgba(255,255,255,0.15)",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            background: "linear-gradient(90deg, #7c3aed, #a855f7)",
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  );
});
