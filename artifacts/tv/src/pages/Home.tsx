import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveHero } from "../components/LiveHero";
import { BroadcastOnAirStrip } from "../components/BroadcastOnAirStrip";
import { TempleTvLogo } from "../components/TempleTvLogo";
import ChatOverlay from "../components/ChatOverlay";
import { SermonRow } from "../components/SermonRow";
import { Clock } from "../components/Clock";
import { useTVNav } from "../hooks/useTVNav";
import { useSermons } from "../hooks/useData";
import { useUnifiedLive } from "../hooks/useUnifiedLive";
import { fetchBroadcastCurrent } from "../lib/api";
import type { VideoItem, BroadcastCurrent } from "../lib/api";
import { useLiveSync } from "../hooks/useLiveSync";
import { BROADCAST_TITLE } from "../lib/broadcastIdentity";
import { readLastBroadcast, writeLastBroadcast } from "../lib/lastBroadcastCache";

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
  onPlay: (videoId: string, title: string, hlsUrl?: string, startPositionSecs?: number, isLive?: boolean) => void;
  onDetails: (video: VideoItem, related: VideoItem[]) => void;
}

export function Home({ onNavigateGuide, onNavigateSearch, onPlay, onDetails }: HomeProps) {
  const { byCategory, sermons, loading } = useSermons();
  // Unified live state: an admin "Activate live stream" override (delivered
  // via SSE through useLiveSync) takes priority; the YouTube channel scrape
  // is the fallback when no override is active. This keeps the LiveHero,
  // the channel-grid `__live__` row, and <Player> on the exact same source —
  // the moment an admin presses Activate, every surface flips together.
  const liveStatus = useUnifiedLive();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [guideButtonFocused, setGuideButtonFocused] = useState(false);
  const [searchButtonFocused, setSearchButtonFocused] = useState(false);
  // Cold-start instant-paint: hydrate from sessionStorage (synchronous, no
  // network) so the cinematic hero renders the last-known on-air program in
  // the very first paint instead of flashing the off-air gradient for the
  // ~100–500 ms it takes the SSE handshake or HTTP primer to land. Cache TTL
  // is 60 s so position-derived math (`computeLiveBroadcastPosition`) can
  // never drift past the item's duration before fresh data overwrites it.
  const [broadcastCurrent, setBroadcastCurrent] = useState<BroadcastCurrent | null>(
    () => readLastBroadcast(),
  );

  // Real-time hero sync strategy:
  //
  // 1. `useLiveSync` already carries the *full* BroadcastCurrentPayload on every
  //    `broadcast-current-updated` SSE message via its new `payload` field. When
  //    SSE is healthy that payload IS the source of truth — no extra HTTP round-
  //    trip is required for the cinematic hero to render fresh metadata, and a
  //    transient HTTP failure can never strand the hero on stale content.
  // 2. The HTTP `fetchBroadcastCurrent` is kept as (a) a cold-start primer so
  //    the hero has data before SSE handshakes, and (b) a 60s safety poll for
  //    the rare case SSE drops silently mid-session.
  // 3. The cold-start fetch retries with bounded exponential backoff so a
  //    one-off network blip during page mount doesn't leave the hero blank.
  const liveSync = useLiveSync();

  // Promote the SSE payload directly into the hero's local state so the
  // cinematic hero updates within milliseconds of a queue transition or
  // override change — no HTTP fetch required on the hot path. Also persist
  // to the instant-paint cache so the next cold-start lands on the truth.
  useEffect(() => {
    if (liveSync.payload) {
      const next = liveSync.payload as unknown as BroadcastCurrent;
      setBroadcastCurrent(next);
      writeLastBroadcast(next);
    }
  }, [liveSync.payload]);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const bc = await fetchBroadcastCurrent();
        if (cancelled) return;
        setBroadcastCurrent(bc);
        writeLastBroadcast(bc);
        attempt = 0;
      } catch {
        if (cancelled) return;
        // Bounded exponential backoff for the cold-start primer. If SSE comes
        // online first the `liveSync.payload` effect above will already have
        // populated the hero, so these retries simply self-cancel on success.
        if (attempt < 4) {
          const delay = Math.min(1500 * Math.pow(2, attempt), 12_000);
          attempt++;
          retryTimer = setTimeout(load, delay);
        }
      }
    };

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  // ── Build a unified rows array for useTVNav ───────────────────────────
  // Row 0: Live hero (always present as placeholder — count = 1 even when off-air)
  // Row 1+: Content categories. The homepage is broadcast-first; we no
  // longer surface a "Continue Watching" content-library row here.
  const rows = useMemo(() => [
    { key: "__live__", label: "Live", items: 1 },
    ...CATEGORIES.map((cat) => ({ key: cat, label: cat, items: (byCategory[cat] ?? []).length })),
  ].filter((r) => r.items > 0), [byCategory]);

  const getRowItemCount = useCallback(
    (rowIndex: number) => rows[rowIndex]?.items ?? 0,
    [rows],
  );

  // Drift-correct the broadcast position to right-now so the Player joins at
  // the exact second the hero was already showing — without this, navigating
  // would always land us a few seconds behind whatever the user just saw.
  const computeLiveBroadcastPosition = useCallback((): number => {
    if (!broadcastCurrent?.item) return 0;
    const drift = (Date.now() - broadcastCurrent.serverTimeMs) / 1000;
    const target = broadcastCurrent.positionSecs + drift;
    const dur = broadcastCurrent.item.durationSecs ?? 0;
    if (dur > 0) return Math.max(0, Math.min(target, dur - 0.5));
    return Math.max(0, target);
  }, [broadcastCurrent]);

  const onSelect = useCallback(
    (rowIndex: number, itemIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;

      if (row.key === "__live__") {
        if (liveStatus?.isLive && liveStatus.videoId) {
          // YouTube live event — flag as live so the player suppresses controls.
          // Round 9c: pass the channel identity rather than the per-program
          // title; the Player.tsx live mode already hides the title chrome,
          // but propagating the generic value at the route level keeps
          // history / state / accessibility readouts broadcast-clean.
          onPlay(liveStatus.videoId, BROADCAST_TITLE, undefined, undefined, true);
        } else if (broadcastCurrent?.item) {
          const item = broadcastCurrent.item;
          const hlsUrl = item.localVideoUrl ?? undefined;
          const id = item.youtubeId ?? item.videoId;
          // Pass the live-corrected broadcast position so the player joins at
          // the exact moment currently airing rather than the cached position.
          // isLive=true → no scrubber, no SPACE/pause hint, no manual controls.
          onPlay(id, "Temple TV", hlsUrl, computeLiveBroadcastPosition(), true);
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
    [rows, byCategory, liveStatus, onPlay, onDetails, broadcastCurrent, computeLiveBroadcastPosition],
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

  // Category rows start at index 1 (right after the live hero at index 0).
  const catRowOffset = 1;

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
          <TempleTvLogo size={44} variant="wordmark" priority />
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

      {/* NOW ON AIR + UP NEXT strip — overlays the hero so viewers always
          see what's airing now and what's next, even before they interact. */}
      <BroadcastOnAirStrip liveStatus={liveStatus} broadcastCurrent={broadcastCurrent} />

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
                // YouTube live event — flag as live (no manual controls).
                // Round 9c: channel identity instead of per-program title
                // for broadcast-clean parity with the broadcast-queue path
                // and the mobile equivalent.
                onPlay(liveStatus.videoId, BROADCAST_TITLE, undefined, undefined, true);
              } else if (broadcastCurrent?.item) {
                const item = broadcastCurrent.item;
                const hlsUrl = item.localVideoUrl ?? undefined;
                const id = item.youtubeId ?? item.videoId;
                // Live-corrected position: hand the player the exact second
                // the hero is showing right now, not the cached fetch value.
                // isLive=true → TV-channel behavior on the resulting Player.
                onPlay(id, "Temple TV", hlsUrl, computeLiveBroadcastPosition(), true);
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
        {/* Always-on chat overlay, collapsed by default so it doesn't compete
            with the home grid; one tap expands. */}
        <ChatOverlay compact />
      </div>
    </div>
  );
}
