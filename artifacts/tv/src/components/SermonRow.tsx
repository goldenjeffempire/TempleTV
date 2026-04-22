import React from "react";
import { SermonCard } from "./SermonCard";
import type { Sermon } from "../hooks/useData";

interface SermonRowProps {
  title: string;
  sermons: Sermon[];
  focusedIndex: number;
  rowFocused: boolean;
  onCardFocus: (index: number) => void;
  onCardSelect: (sermon: Sermon) => void;
}

export function SermonRow({
  title,
  sermons,
  focusedIndex,
  rowFocused,
  onCardFocus,
  onCardSelect,
}: SermonRowProps) {
  if (sermons.length === 0) return null;

  return (
    <div
      className={`tv-row ${rowFocused ? "tv-row-focused" : ""}`}
      style={{ marginBottom: 36 }}
    >
      {/* Row label — slightly larger, brighter when this row is active */}
      <h2
        style={{
          fontSize: "clamp(18px, 1.6vw, 24px)",
          fontWeight: 700,
          color: rowFocused ? "#fff" : "rgba(255,255,255,0.6)",
          marginBottom: 18,
          paddingLeft: "var(--tv-safe-h, 60px)",
          letterSpacing: "0.01em",
          transition: "color 0.2s ease",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        {/* Active row indicator bar */}
        {rowFocused && (
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 4,
              height: "1em",
              borderRadius: 2,
              background: "hsl(var(--primary))",
              marginRight: 2,
              flexShrink: 0,
            }}
          />
        )}
        {title}
      </h2>

      {/* Horizontally scrollable card strip */}
      <div
        style={{
          display: "flex",
          gap: 18,
          paddingLeft: "var(--tv-safe-h, 60px)",
          paddingRight: "var(--tv-safe-h, 60px)",
          paddingBottom: 10,
          overflowX: "hidden",
        }}
      >
        {sermons.map((sermon, i) => (
          <SermonCard
            key={sermon.videoId}
            sermon={sermon}
            focused={rowFocused && focusedIndex === i}
            onFocus={() => onCardFocus(i)}
            onClick={() => onCardSelect(sermon)}
          />
        ))}
      </div>
    </div>
  );
}
