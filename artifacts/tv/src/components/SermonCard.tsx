import React, { useRef, useEffect } from "react";
import type { Sermon } from "../hooks/useData";

interface SermonCardProps {
  sermon: Sermon;
  focused: boolean;
  onFocus: () => void;
  onClick: () => void;
  style?: React.CSSProperties;
}

// 10-foot viewing card dimensions — readable at 3m from a 55"+ display.
// Width: fits ~5 cards across 1920px with safe-zone + gap.
const CARD_W = 348;
const CARD_H = 196;

export const SermonCard = React.memo(function SermonCard({
  sermon,
  focused,
  onFocus,
  onClick,
  style,
}: SermonCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }, [focused]);

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="button"
      aria-label={`Play ${sermon.title}`}
      aria-pressed={focused}
      className={`tv-card flex-shrink-0 relative rounded-xl overflow-hidden cursor-pointer ${focused ? "tv-focused" : ""}`}
      style={{
        width: CARD_W,
        height: CARD_H,
        background: "#1a1a1a",
        borderRadius: 14,
        ...style,
      }}
      onFocus={onFocus}
      onClick={onClick}
    >
      {/* Thumbnail */}
      <img
        src={sermon.thumbnailUrl || `https://img.youtube.com/vi/${sermon.videoId}/hqdefault.jpg`}
        alt={sermon.title}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        loading="lazy"
      />

      {/* Bottom gradient */}
      <div className="gradient-bottom absolute inset-0" />

      {/* Text overlay */}
      <div className="absolute bottom-0 left-0 right-0" style={{ padding: "12px 14px" }}>
        <p
          className="line-clamp-2 text-white"
          style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}
        >
          {sermon.title}
        </p>
        {!!sermon.duration && (
          <p
            className="text-white/60 mt-1"
            style={{ fontSize: 13, fontWeight: 500 }}
          >
            {formatDuration(sermon.duration)}
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
  );
});

function formatDuration(iso: string): string {
  if (!iso) return "";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const h = parseInt(m[1] ?? "0");
  const min = parseInt(m[2] ?? "0");
  const sec = parseInt(m[3] ?? "0");
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${min}:${String(sec).padStart(2, "0")}`;
}
