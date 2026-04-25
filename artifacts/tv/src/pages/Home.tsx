import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveHero } from "../components/LiveHero";
import { TempleTvLogo } from "../components/TempleTvLogo";
import { SermonRow } from "../components/SermonRow";
import { ContinueWatchingCard } from "../components/ContinueWatchingCard";
import { Clock } from "../components/Clock";
import { useTVNav } from "../hooks/useTVNav";
import { useSermons, useLiveStatus } from "../hooks/useData";
import { useWatchHistory } from "../hooks/useWatchHistory";
import { fetchBroadcastCurrent } from "../lib/api";
import type { VideoItem, BroadcastCurrent } from "../lib/api";
import { useLiveSync } from "../hooks/useLiveSync";

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
  onPlay: (videoId: string, title: string, hlsUrl?: string, startPositionSecs?: number) => void;
  onDetails: (video: VideoItem, related: VideoItem[]) => void;
}

export function Home({ onNavigateGuide, onNavigateSearch, onPlay, onDetails }: HomeProps) {
  const { byCategory, sermons, loading } = useSermons();
  const liveStatus = useLiveStatus();
  const { continueWatching } = useWatchHistory();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [guideButtonFocused, setGuideButtonFocused] = useState(false);
  const [searchButtonFocused, setSearchButtonFocused] = useState(false);
  const [broadcastCurrent, setBroadcastCurrent] = useState<BroadcastCurrent | null>(null);

  // Use SSE to get real-time broadcast updates (useLiveSync handles SSE + fallback polling).
  // When the hook signals a state change (syncedAt changes), re-fetch the full BroadcastCurrent
  // so LiveHero gets fresh item metadata (thumbnail, nextItem, etc.) immediately.
  const liveSync = useLiveSync();
  const loadBroadcastRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const bc = await fetchBroadcastCurrent();
        if (!cancelled) setBroadcastCurrent(bc);
      } catch {}
    };
    loadBroadcastRef.current = load;

    // Initial load + long-interval fallback for when SSE is unavailable
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); loadBroadcastRef.current = null; };
  }, []);

  // When useLiveSync receives a broadcast-current-updated SSE event, its syncedAt
  // changes — trigger an immediate re-fetch of the full BroadcastCurrent payload
  // so the LiveHero updates within seconds of a queue item transition.
  useEffect(() => {
    if (liveSync.syncedAt) loadBroadcastRef.current?.();
  }, [liveSync.syncedAt]);

  const hasContinueWatching = continueWatching.length > 0;

  // ── Build a unified rows array for useTVNav ───────────────────────────
  // Row 0: Live hero (always present as placeholder — count = 1 even when off-air)
  // Row 1: Continue Watching (only when history exists)
  // Row 2+: Content categories
  const rows = useMemo(() => [
    { key: "__live__", label: "Live", items: 1 },
    ...(hasContinueWatching ? [{ key: "__continue__", label: "Continue Watching", items: continueWatching.length }] : []),
    ...CATEGORIES.map((cat) => ({ key: cat, label: cat, items: (byCategory[cat] ?? []).length })),
  ].filter((r) => r.items > 0), [hasContinueWatching, continueWatching.length, byCategory]);

  const getRowItemCount = useCallback(
    (rowIndex: number) => rows[rowIndex]?.items ?? 0,
    [rows],
  );

  const onSelect = useCallback(
    (rowIndex: number, itemIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;

      if (row.key === "__live__") {
        if (liveStatus?.isLive && liveStatus.videoId) {
          onPlay(liveStatus.videoId, liveStatus.title ?? "Live Stream");
        } else if (broadcastCurrent?.item) {
          const item = broadcastCurrent.item;
          const hlsUrl = item.localVideoUrl ?? undefined;
          const id = item.youtubeId ?? item.videoId;
          // Pass the current broadcast position so the player joins in-sync
          onPlay(id, "Temple TV", hlsUrl, broadcastCurrent.positionSecs);
        }
        return;
      }

      if (row.key === "__continue__") {
        const entry = continueWatching[itemIndex];
        if (entry) onPlay(entry.videoId, entry.title);
        return;
      }

      const rowSermons = byCategory[row.key] ?? [];
      const sermon = rowSermons[itemIndex];
      if (sermon) {
        const related = rowSermons.filter((s) => s.videoId !== sermon.videoId);
        onDetails(sermon, related);
      }
    },
    [rows, byCategory, liveStatus, onPlay, onDetails, continueWatching],
  );

  const onHeaderSelect = useCallback(
    (itemIndex: number) => {
      if (itemIndex === 0) onNavigateSearch();
      else if (itemIndex === 1) onNavigateGuide();
    },
    [onNavigateGuide, onNavigateSearch],
  );

  const { focusRow, getFocusItem, focusZone, headerItem } = useTVNav({
    rowCount: rows.length,
    getRowItemCount,
    onSelect,
    enabled: true,
    headerItemCount: 2,
    onHeaderSelect,
  });

  const searchHeaderFocused = focusZone === "header" && headerItem === 0;
  const guideHeaderFocused = focusZone === "header" && headerItem === 1;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "g" || e.key === "G") { e.preventDefault(); onNavigateGuide(); }
      if (e.key === "s" || e.key === "S") { e.preventDefault(); onNavigateSearch(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNavigateGuide, onNavigateSearch]);

  // Determine Continue Watching row index (dynamic — 1 if it exists)
  const cwRowIndex = hasContinueWatching ? 1 : -1;
  // Category row offset — 1 if live-only, 2 if CW also exists
  const catRowOffset = hasContinueWatching ? 2 : 1;

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", background: "#070707" }}>
      {/* Netflix-style transparent header */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "22px 60px 36px",
          background: "linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.45) 60%, rgba(0,0,0,0) 100%)",
          pointerEvents: "none",
        }}
      >
        <div style={{ pointerEvents: "auto" }}>
          <TempleTvLogo size={44} withWordmark />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, pointerEvents: "auto" }}>
          <button
            onClick={onNavigateSearch}
            onFocus={() => setSearchButtonFocused(true)}
            onBlur={() => setSearchButtonFocused(false)}
            title="Search (S)"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10,
              background: (searchButtonFocused || searchHeaderFocused) ? "rgba(106,13,173,0.5)" : "rgba(255,255,255,0.08)",
              border: `1px solid ${(searchButtonFocused || searchHeaderFocused) ? "rgba(106,13,173,0.7)" : "rgba(255,255,255,0.15)"}`,
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
              outline: searchHeaderFocused ? "2px solid rgba(106,13,173,0.9)" : "none",
              outlineOffset: 2,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            Search
          </button>

          <button
            onClick={onNavigateGuide}
            onFocus={() => setGuideButtonFocused(true)}
            onBlur={() => setGuideButtonFocused(false)}
            title="TV Guide (G)"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10,
              background: (guideButtonFocused || guideHeaderFocused) ? "rgba(106,13,173,0.5)" : "rgba(255,255,255,0.08)",
              border: `1px solid ${(guideButtonFocused || guideHeaderFocused) ? "rgba(106,13,173,0.7)" : "rgba(255,255,255,0.15)"}`,
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
              outline: guideHeaderFocused ? "2px solid rgba(106,13,173,0.9)" : "none",
              outlineOffset: 2,
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
      <div ref={scrollRef} style={{ position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden", paddingBottom: 40 }}>
        {/* Hero */}
        <div style={{ marginBottom: 24 }}>
          <LiveHero
            liveStatus={liveStatus}
            broadcastCurrent={broadcastCurrent}
            focused={focusRow === 0}
            onSelect={() => {
              if (liveStatus?.isLive && liveStatus.videoId) {
                onPlay(liveStatus.videoId, liveStatus.title ?? "Live");
              } else if (broadcastCurrent?.item) {
                const item = broadcastCurrent.item;
                const hlsUrl = item.localVideoUrl ?? undefined;
                const id = item.youtubeId ?? item.videoId;
                // Thread the current broadcast position for synchronized join-in
                onPlay(id, "Temple TV", hlsUrl, broadcastCurrent.positionSecs);
              }
            }}
          />
        </div>

        {loading ? (
          <div style={{ paddingLeft: "var(--tv-safe-h, 60px)", paddingTop: 8 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ marginBottom: 40 }}>
                <div className="skeleton" style={{ width: 180, height: 22, marginBottom: 16 }} />
                <div style={{ display: "flex", gap: 18 }}>
                  {[0, 1, 2, 3, 4].map((j) => (
                    <div key={j} className="skeleton" style={{ width: 348, height: 196, borderRadius: 14 }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={focusZone === "grid" ? "tv-rows-active" : ""}>

            {/* ── Continue Watching row ─────────────────────────────────── */}
            {hasContinueWatching && (
              <div
                className={`tv-row tv-row-continue-watching ${focusRow === cwRowIndex ? "tv-row-focused" : ""}`}
                style={{ marginBottom: 36 }}
              >
                <h2 style={{
                  fontSize: "clamp(18px, 1.6vw, 24px)",
                  fontWeight: 700,
                  color: focusRow === cwRowIndex ? "#fff" : "rgba(255,255,255,0.6)",
                  marginBottom: 18,
                  paddingLeft: "var(--tv-safe-h, 60px)",
                  letterSpacing: "0.01em",
                  transition: "color 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}>
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "linear-gradient(135deg, #7c3aed, #a855f7)",
                    flexShrink: 0,
                  }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="white">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                  </span>
                  Continue Watching
                </h2>
                <div style={{
                  display: "flex",
                  gap: 18,
                  paddingLeft: "var(--tv-safe-h, 60px)",
                  paddingRight: "var(--tv-safe-h, 60px)",
                  overflowX: "auto",
                  scrollbarWidth: "none",
                  msOverflowStyle: "none",
                }}>
                  {continueWatching.map((entry, idx) => (
                    <ContinueWatchingCard
                      key={entry.videoId}
                      entry={entry}
                      focused={focusRow === cwRowIndex && getFocusItem(cwRowIndex) === idx}
                      onFocus={() => {}}
                      onClick={() => onPlay(entry.videoId, entry.title)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Category rows ─────────────────────────────────────────── */}
            {CATEGORIES.map((cat, catIndex) => {
              const rowSermons = byCategory[cat] ?? [];
              if (rowSermons.length === 0) return null;
              const rowIndex = catIndex + catRowOffset;
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
            })}
          </div>
        )}

        <div style={{ paddingLeft: 60, paddingTop: 16 }}>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>
            ↑ ↓ Navigate rows &nbsp;·&nbsp; ← → Select &nbsp;·&nbsp; ENTER Open &nbsp;·&nbsp; G Guide &nbsp;·&nbsp; S Search
          </p>
        </div>
      </div>
    </div>
  );
}
