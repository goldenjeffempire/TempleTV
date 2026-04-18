import React, { useRef, useEffect } from "react";
import type { Sermon } from "../hooks/useData";

interface SermonCardProps {
  sermon: Sermon;
  focused: boolean;
  onFocus: () => void;
  onClick: () => void;
  style?: React.CSSProperties;
}

const CARD_W = 320;
const CARD_H = 180;

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
      className={`tv-card flex-shrink-0 relative rounded-xl overflow-hidden cursor-pointer ${focused ? "tv-focused" : ""}`}
      style={{ width: CARD_W, height: CARD_H, background: "#1a1a1a", ...style }}
      onFocus={onFocus}
      onClick={onClick}
    >
      <img
        src={sermon.thumbnailUrl || `https://img.youtube.com/vi/${sermon.videoId}/hqdefault.jpg`}
        alt={sermon.title}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        loading="lazy"
      />
      <div className="gradient-bottom absolute inset-0" />
      <div className="absolute bottom-0 left-0 right-0 p-3">
        <p className="line-clamp-2 text-white" style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
          {sermon.title}
        </p>
        {!!sermon.duration && (
          <p className="text-white/60 mt-1" style={{ fontSize: 13 }}>{formatDuration(sermon.duration)}</p>
        )}
      </div>
      {focused && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.3)" }}
        >
          <div
            className="flex items-center justify-center rounded-full"
            style={{ width: 54, height: 54, background: "rgba(255,255,255,0.18)", backdropFilter: "blur(4px)" }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
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
