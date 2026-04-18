import React, { useRef } from "react";
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
    <div style={{ marginBottom: 32 }}>
      <h2
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: "rgba(255,255,255,0.85)",
          marginBottom: 16,
          paddingLeft: 60,
          letterSpacing: "0.01em",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          display: "flex",
          gap: 16,
          paddingLeft: 60,
          paddingRight: 60,
          paddingBottom: 8,
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
