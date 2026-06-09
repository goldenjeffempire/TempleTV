import { useCallback, useEffect, useRef, useState } from "react";
import { SermonCard } from "../components/SermonCard";
import type { Sermon } from "../hooks/useData";

const PAGE_SIZE = 24;

const CATEGORY_ACCENT: Record<string, string> = {
  "Live Service": "#22c55e",
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
};

interface CategoryPageProps {
  title: string;
  sermons: Sermon[];
  onBack: () => void;
  onCardSelect: (sermon: Sermon) => void;
}

export function CategoryPage({ title, sermons, onBack, onCardSelect }: CategoryPageProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const gridRef = useRef<HTMLDivElement>(null);

  const visible = sermons.slice(0, visibleCount);
  const hasMore = visibleCount < sermons.length;
  const accent = CATEGORY_ACCENT[title] ?? "#a855f7";

  const loadMore = useCallback(() => {
    setVisibleCount((n) => Math.min(n + PAGE_SIZE, sermons.length));
  }, [sermons.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "GoBack" || e.key === "Backspace") {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div
      style={{
        background: "#0a0a0a",
        minHeight: "100vh",
        color: "#fff",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        overflowY: "auto",
      }}
    >
      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding:
            "clamp(20px, 3vh, 40px) var(--tv-safe-h, 60px) clamp(12px, 1.5vh, 24px)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          position: "sticky",
          top: 0,
          background: "rgba(10,10,10,0.96)",
          backdropFilter: "blur(12px)",
          zIndex: 10,
        }}
      >
        {/* Back button */}
        <button
          onClick={onBack}
          style={{
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            cursor: "pointer",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0,
            transition: "background 0.15s ease",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "rgba(255,255,255,0.13)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "rgba(255,255,255,0.08)")
          }
          aria-label="Go back"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Back
        </button>

        {/* Accent bar */}
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 5,
            height: 30,
            borderRadius: 3,
            background: accent,
            flexShrink: 0,
            boxShadow: `0 0 14px ${accent}80`,
          }}
        />

        {/* Title + count */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1
            style={{
              fontSize: "clamp(20px, 2.2vw, 34px)",
              fontWeight: 800,
              margin: 0,
              letterSpacing: "-0.02em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </h1>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 13,
              color: "rgba(255,255,255,0.4)",
            }}
          >
            {sermons.length.toLocaleString()}{" "}
            {sermons.length === 1 ? "video" : "videos"}
            {hasMore && (
              <> &nbsp;·&nbsp; showing {visibleCount.toLocaleString()}</>
            )}
          </p>
        </div>
      </div>

      {/* ── Video grid ─────────────────────────────────────────────────────── */}
      <div
        ref={gridRef}
        style={{
          padding:
            "clamp(24px, 3vh, 48px) var(--tv-safe-h, 60px) clamp(16px, 2vh, 32px)",
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fill, minmax(clamp(155px, 17vw, 215px), 1fr))",
          gap: "clamp(14px, 1.8vw, 24px)",
        }}
      >
        {visible.map((sermon, i) => (
          <SermonCard
            key={sermon.videoId}
            sermon={sermon}
            focused={focusedIdx === i}
            onFocus={() => setFocusedIdx(i)}
            onClick={() => onCardSelect(sermon)}
          />
        ))}
      </div>

      {/* ── Load More ──────────────────────────────────────────────────────── */}
      {hasMore && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "8px 0 clamp(40px, 5vh, 72px)",
          }}
        >
          <button
            onClick={loadMore}
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 14,
              cursor: "pointer",
              color: "#fff",
              fontSize: 15,
              fontWeight: 600,
              padding: "14px 44px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              transition: "background 0.15s ease, border-color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.12)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.07)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)";
            }}
          >
            Load More
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
            <span
              style={{ fontSize: 13, color: "rgba(255,255,255,0.38)", fontWeight: 400 }}
            >
              {(sermons.length - visibleCount).toLocaleString()} more
            </span>
          </button>
        </div>
      )}

      {/* No results */}
      {sermons.length === 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "80px 60px",
            gap: 16,
            color: "rgba(255,255,255,0.35)",
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <p style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>
            No videos in {title}
          </p>
          <p style={{ fontSize: 14, margin: 0 }}>
            Check back later or explore other categories.
          </p>
        </div>
      )}
    </div>
  );
}
