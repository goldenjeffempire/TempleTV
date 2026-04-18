import { useCallback, useEffect, useRef, useState } from "react";
import { LiveHero } from "../components/LiveHero";
import { SermonRow } from "../components/SermonRow";
import { Clock } from "../components/Clock";
import { useTVNav } from "../hooks/useTVNav";
import { useSermons, useLiveStatus } from "../hooks/useData";
import type { VideoItem } from "../lib/api";

const CATEGORIES = [
  "Faith",
  "Healing",
  "Deliverance",
  "Worship",
  "Teachings",
  "Special Programs",
];

interface HomeProps {
  onNavigateGuide: () => void;
  onNavigateSearch: () => void;
  onPlay: (videoId: string, title: string) => void;
  onDetails: (video: VideoItem, related: VideoItem[]) => void;
}

export function Home({ onNavigateGuide, onNavigateSearch, onPlay, onDetails }: HomeProps) {
  const { byCategory, sermons, loading } = useSermons();
  const liveStatus = useLiveStatus();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [guideButtonFocused, setGuideButtonFocused] = useState(false);
  const [searchButtonFocused, setSearchButtonFocused] = useState(false);

  const rows = [
    { key: "__live__", label: "Live", items: liveStatus?.isLive ? 1 : 0 },
    ...CATEGORIES.map((cat) => ({ key: cat, label: cat, items: (byCategory[cat] ?? []).length })),
  ].filter((r) => r.items > 0 || r.key === "__live__");

  const getRowItemCount = useCallback(
    (rowIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return 0;
      if (row.key === "__live__") return 1;
      return byCategory[row.key]?.length ?? 0;
    },
    [rows, byCategory],
  );

  const onSelect = useCallback(
    (rowIndex: number, itemIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;
      if (row.key === "__live__") {
        if (liveStatus?.isLive && liveStatus.videoId) {
          onPlay(liveStatus.videoId, liveStatus.title ?? "Live Stream");
        }
        return;
      }
      const rowSermons = byCategory[row.key] ?? [];
      const sermon = rowSermons[itemIndex];
      if (sermon) {
        const related = rowSermons.filter((s) => s.videoId !== sermon.videoId);
        onDetails(sermon, related);
      }
    },
    [rows, byCategory, liveStatus, onPlay, onDetails],
  );

  const { focusRow, getFocusItem } = useTVNav({
    rowCount: rows.length,
    getRowItemCount,
    onSelect,
    enabled: true,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "g" || e.key === "G") { e.preventDefault(); onNavigateGuide(); }
      if (e.key === "s" || e.key === "S") { e.preventDefault(); onNavigateSearch(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNavigateGuide, onNavigateSearch]);

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 60px", flexShrink: 0 }}>
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center rounded-xl" style={{ width: 42, height: 42, background: "hsl(0 78% 50%)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 12L8 9l1.41-1.41L12 10.17l2.59-2.58L16 9l-4 6z" />
              <path d="M8 15V9l8 3-8 3z" />
            </svg>
          </div>
          <div>
            <span style={{ fontSize: 24, fontWeight: 800, color: "#fff", letterSpacing: "-0.01em" }}>Temple TV</span>
            <span style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", marginLeft: 8 }}>JCTM</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Search button */}
          <button
            onClick={onNavigateSearch}
            onFocus={() => setSearchButtonFocused(true)}
            onBlur={() => setSearchButtonFocused(false)}
            title="Search (S)"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10,
              background: searchButtonFocused ? "rgba(106,13,173,0.5)" : "rgba(255,255,255,0.08)",
              border: `1px solid ${searchButtonFocused ? "rgba(106,13,173,0.7)" : "rgba(255,255,255,0.15)"}`,
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            Search
          </button>

          {/* Guide button */}
          <button
            onClick={onNavigateGuide}
            onFocus={() => setGuideButtonFocused(true)}
            onBlur={() => setGuideButtonFocused(false)}
            title="TV Guide (G)"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10,
              background: guideButtonFocused ? "rgba(106,13,173,0.5)" : "rgba(255,255,255,0.08)",
              border: `1px solid ${guideButtonFocused ? "rgba(106,13,173,0.7)" : "rgba(255,255,255,0.15)"}`,
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="9" x2="9" y2="21"/>
            </svg>
            Guide
          </button>

          <Clock />
        </div>
      </div>

      {/* Scrollable content */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", paddingBottom: 40 }}>
        <div style={{ marginBottom: 24 }}>
          <LiveHero
            liveStatus={liveStatus}
            focused={focusRow === 0}
            onSelect={() => {
              if (liveStatus?.isLive && liveStatus.videoId) {
                onPlay(liveStatus.videoId, liveStatus.title ?? "Live");
              }
            }}
          />
        </div>

        {loading ? (
          <div style={{ paddingLeft: 60, paddingTop: 8 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ marginBottom: 40 }}>
                <div className="skeleton" style={{ width: 180, height: 22, marginBottom: 16 }} />
                <div style={{ display: "flex", gap: 16 }}>
                  {[0, 1, 2, 3, 4].map((j) => (
                    <div key={j} className="skeleton" style={{ width: 320, height: 180, borderRadius: 12 }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          CATEGORIES.map((cat, catIndex) => {
            const rowSermons = byCategory[cat] ?? [];
            if (rowSermons.length === 0) return null;
            const rowIndex = catIndex + 1;
            return (
              <SermonRow
                key={cat}
                title={cat}
                sermons={rowSermons}
                focusedIndex={getFocusItem(rowIndex)}
                rowFocused={focusRow === rowIndex}
                onCardFocus={() => {}}
                onCardSelect={(sermon) => {
                  const related = rowSermons.filter((s) => s.videoId !== sermon.videoId);
                  onDetails(sermon, related);
                }}
              />
            );
          })
        )}

        <div style={{ paddingLeft: 60, paddingTop: 16 }}>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>
            ↑ ↓ Navigate rows &nbsp;·&nbsp; ← → Select &nbsp;·&nbsp; ENTER Details &nbsp;·&nbsp; G Guide &nbsp;·&nbsp; S Search
          </p>
        </div>
      </div>
    </div>
  );
}
