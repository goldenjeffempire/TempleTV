import React, { useRef, useEffect, useState } from "react";
import type { Sermon } from "../hooks/useData";
import { prefetchManifest, preconnectMediaHost } from "../lib/manifest-prefetch";

interface SermonCardProps {
  sermon: Sermon;
  focused: boolean;
  onFocus: () => void;
  onClick: () => void;
  style?: React.CSSProperties;
}

// Mobile-first card width — scales from 2-card mobile to 5-card TV layout.
// 42 vw gives ~163 px on a 390 px phone (2+ cards visible, with peek).
// Clamped to 340 px for 1920 px TV panels where 5 cards fill the row.
const CARD_W = "clamp(155px, 42vw, 340px)";

export const SermonCard = React.memo(function SermonCard({
  sermon,
  focused,
  onFocus,
  onClick,
  style,
}: SermonCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
      const hls =
        (sermon as { hlsUrl?: string | null }).hlsUrl ??
        (sermon as { localVideoUrl?: string | null }).localVideoUrl ??
        null;
      if (hls) {
        preconnectMediaHost(hls);
        prefetchManifest(hls);
      }
    }
  }, [focused, sermon]);

  const thumbSrc = imgFailed
    ? null
    : sermon.thumbnailUrl ||
      (sermon.videoSource !== "local" && sermon.videoId
        ? `https://img.youtube.com/vi/${sermon.videoId}/hqdefault.jpg`
        : null);

  const durationLabel = sermon.duration ? formatDuration(sermon.duration) : null;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="button"
      aria-label={`Play ${sermon.title}`}
      aria-pressed={focused}
      className={`tt-card ${focused ? "tv-focused" : ""}`}
      style={{
        width: CARD_W,
        aspectRatio: "16 / 9",
        borderRadius: 12,
        overflow: "hidden",
        background: "#0e0e16",
        flexShrink: 0,
        ...style,
      }}
      onFocus={onFocus}
      onClick={onClick}
    >
      {/* Thumbnail — cover fill so there are no black bars */}
      {thumbSrc ? (
        <img
          src={thumbSrc}
          alt={sermon.title}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
            display: "block",
          }}
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(135deg, #160030 0%, #08000f 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="rgba(255,255,255,0.12)">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      )}

      {/* Premium gradient overlay — stronger at bottom */}
      <div
        className="tt-card-overlay"
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.55) 40%, rgba(0,0,0,0.08) 75%, transparent 100%)",
          transition: "background 0.2s ease",
        }}
      />

      {/* Duration badge — top-right glass pill */}
      {durationLabel && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "rgba(0,0,0,0.72)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            borderRadius: 5,
            padding: "2px 7px",
            fontSize: "clamp(9px, 0.62vw, 11px)",
            fontWeight: 700,
            color: "rgba(255,255,255,0.88)",
            letterSpacing: "0.04em",
            lineHeight: 1.5,
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {durationLabel}
        </div>
      )}

      {/* Play button — always visible; brightens on hover (via CSS) / focus */}
      <div
        className="tt-play-btn"
        aria-hidden
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "clamp(34px, 2.8vw, 50px)",
          height: "clamp(34px, 2.8vw, 50px)",
          borderRadius: "50%",
          background: focused
            ? "rgba(255,255,255,0.22)"
            : "rgba(255,255,255,0.10)",
          border: `2px solid ${focused ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.22)"}`,
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: focused ? 1 : 0.55,
          flexShrink: 0,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="white"
          style={{ marginLeft: 2, flexShrink: 0 }}
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>

      {/* Text overlay — title + optional meta */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          padding: "clamp(7px, 0.65vw, 11px) clamp(8px, 0.75vw, 12px)",
        }}
      >
        <p
          className="line-clamp-2"
          style={{
            fontSize: "clamp(11px, 0.82vw, 14px)",
            fontWeight: 700,
            color: "#fff",
            lineHeight: 1.3,
            letterSpacing: "-0.01em",
          }}
        >
          {sermon.title}
        </p>
      </div>
    </div>
  );
});

function formatDuration(dur: string): string {
  if (!dur) return "";
  const iso = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) {
    const h = parseInt(iso[1] ?? "0");
    const min = parseInt(iso[2] ?? "0");
    const sec = parseInt(iso[3] ?? "0");
    if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${min}:${String(sec).padStart(2, "0")}`;
  }
  const totalSec = parseInt(dur, 10);
  if (!isNaN(totalSec)) {
    const h = Math.floor(totalSec / 3600);
    const min = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${min}:${String(sec).padStart(2, "0")}`;
  }
  return dur;
}
