import React, { memo } from "react";
import { SermonCard } from "./SermonCard";
import type { Sermon } from "../hooks/useData";

interface SermonRowProps {
  title: string;
  sermons: Sermon[];
  focusedIndex: number;
  rowFocused: boolean;
  onCardFocus: (index: number) => void;
  onCardSelect: (sermon: Sermon) => void;
  onSeeAll?: () => void;
}

// Per-category accent colours matching the CSS variables in index.css.
const CATEGORY_ACCENT: Record<string, string> = {
  Faith: "#3b82f6",
  Deliverance: "#ef4444",
  Worship: "#8b5cf6",
  Prophecy: "#f59e0b",
  Teachings: "#10b981",
  Prayers: "#6366f1",
  Crusades: "#f97316",
  Conferences: "#14b8a6",
  Testimonies: "#ec4899",
  "Special Programs": "#a855f7",
  "Continue Watching": "#a855f7",
  Saved: "#a855f7",
  "Sermon Series": "#06b6d4",
};

function getAccent(title: string): string {
  return CATEGORY_ACCENT[title] ?? "#a855f7";
}

export const SermonRow = memo(function SermonRow({
  title,
  sermons,
  focusedIndex,
  rowFocused,
  onCardFocus,
  onCardSelect,
  onSeeAll,
}: SermonRowProps) {
  if (sermons.length === 0) return null;

  const accent = getAccent(title);

  return (
    <div
      className={`tv-row ${rowFocused ? "tv-row-focused" : ""}`}
      style={{ marginBottom: "clamp(28px, 3.5vh, 48px)" }}
    >
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: "var(--tv-safe-h, 48px)",
          paddingRight: "var(--tv-safe-h, 48px)",
          marginBottom: "clamp(12px, 1.2vh, 18px)",
        }}
      >
        <div className="tt-section-title">
          {/* Animated accent bar */}
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: rowFocused ? 5 : 3,
              height: "clamp(16px, 1.5vw, 22px)",
              borderRadius: 3,
              background: accent,
              flexShrink: 0,
              transition: "width 0.2s ease, opacity 0.2s ease",
              opacity: rowFocused ? 1 : 0.55,
              boxShadow: rowFocused ? `0 0 12px ${accent}80` : "none",
            }}
          />
          <span
            style={{
              color: rowFocused ? "#fff" : "rgba(255,255,255,0.72)",
              transition: "color 0.2s ease",
            }}
          >
            {title}
          </span>
          {/* Item count badge */}
          <span
            style={{
              fontSize: "clamp(10px, 0.7vw, 13px)",
              fontWeight: 600,
              color: rowFocused ? accent : "rgba(255,255,255,0.3)",
              transition: "color 0.2s ease",
              opacity: rowFocused ? 1 : 0.8,
            }}
          >
            {sermons.length}
          </span>
        </div>

        {/* "See all" button or keyboard hint */}
        {onSeeAll ? (
          <button
            onClick={onSeeAll}
            className="tt-hide-on-touch"
            style={{
              background: "none",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 8,
              cursor: "pointer",
              color: rowFocused ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.35)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              fontSize: "clamp(11px, 0.75vw, 13px)",
              fontWeight: 600,
              letterSpacing: "0.03em",
              transition: "color 0.15s ease, border-color 0.15s ease",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#fff";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = rowFocused
                ? "rgba(255,255,255,0.75)"
                : "rgba(255,255,255,0.35)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.14)";
            }}
          >
            See All
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          rowFocused && (
            <span
              className="tt-hide-on-touch"
              style={{
                fontSize: "clamp(11px, 0.75vw, 13px)",
                color: "rgba(255,255,255,0.35)",
                letterSpacing: "0.04em",
              }}
            >
              ← → navigate
            </span>
          )
        )}
      </div>

      {/* Horizontally scrollable cards */}
      <div
        style={{
          display: "flex",
          gap: "clamp(10px, 1.1vw, 18px)",
          paddingLeft: "var(--tv-safe-h, 48px)",
          paddingRight: "var(--tv-safe-h, 48px)",
          paddingBottom: 8,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          /* Scroll-snap for a satisfying mobile swipe */
          scrollSnapType: "x proximity",
        } as React.CSSProperties}
      >
        {sermons.map((sermon, i) => (
          <SermonCard
            key={sermon.videoId}
            sermon={sermon}
            focused={rowFocused && focusedIndex === i}
            onFocus={() => onCardFocus(i)}
            onClick={() => onCardSelect(sermon)}
            style={{ scrollSnapAlign: "start" }}
          />
        ))}
        {/* Trailing spacer so last card doesn't sit flush against the edge */}
        <div style={{ width: "var(--tv-safe-h, 48px)", flexShrink: 0 }} />
      </div>
    </div>
  );
});
