import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveHero } from "../components/LiveHero";
import { BroadcastOnAirStrip } from "../components/BroadcastOnAirStrip";
import { TempleTvLogo } from "../components/TempleTvLogo";
import ChatOverlay from "../components/ChatOverlay";
import { SermonRow } from "../components/SermonRow";
import { MobileBottomNav } from "../components/MobileBottomNav";
import { Clock } from "../components/Clock";
import { useTVNav } from "../hooks/useTVNav";
import { useSermons } from "../hooks/useData";
import type { Sermon } from "../hooks/useData";
import { useUnifiedLive } from "../hooks/useUnifiedLive";
import { fetchBroadcastCurrent } from "../lib/api";
import type { VideoItem, BroadcastCurrent } from "../lib/api";
import { useLiveSync } from "../hooks/useLiveSync";
import { BROADCAST_TITLE } from "../lib/broadcastIdentity";
import { readLastBroadcast, writeLastBroadcast } from "../lib/lastBroadcastCache";
import { useSeries } from "../hooks/useSeries";
import type { SeriesItem } from "../hooks/useSeries";
import { useWatchProgress } from "../hooks/useWatchProgress";
import { useFavorites } from "../hooks/useFavorites";

const CATEGORIES = [
  "Live Service",
  "Faith",
  "Deliverance",
  "Worship",
  "Prophecy",
  "Teachings",
  "Prayers",
  "Crusades",
  "Conferences",
  "Testimonies",
  "Special Programs",
];

interface HomeProps {
  onNavigateSearch: () => void;
  onNavigateHistory: () => void;
  onNavigateSettings: () => void;
  onNavigatePlaylists?: () => void;
  onPlay: (videoId: string, title: string, hlsUrl?: string, startPositionSecs?: number, isLive?: boolean) => void;
  onDetails: (video: VideoItem, related: VideoItem[]) => void;
  onSeriesDetail: (series: SeriesItem) => void;
  onCategoryPage: (title: string, sermons: Sermon[]) => void;
}

export function Home({ onNavigateSearch, onNavigateHistory, onNavigateSettings, onNavigatePlaylists, onPlay, onDetails, onSeriesDetail, onCategoryPage }: HomeProps) {
  const { byCategory, sermons, loading, error } = useSermons();
  const { series } = useSeries();
  const { entries: continueWatching, refresh: refreshContinueWatching, remove: removeContinueWatching } = useWatchProgress(5);
  const { favorites } = useFavorites();

  // Refresh the continue-watching store every time Home mounts (i.e. after
  // returning from the Player) so the row updates without a page reload.
  useEffect(() => {
    refreshContinueWatching();
  }, [refreshContinueWatching]);
  // Unified live state: an admin "Activate live stream" override (delivered
  // via SSE through useLiveSync) takes priority; the YouTube channel scrape
  // is the fallback when no override is active. This keeps the LiveHero,
  // the channel-grid `__live__` row, and <Player> on the exact same source —
  // the moment an admin presses Activate, every surface flips together.
  const liveStatus = useUnifiedLive();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchButtonFocused, setSearchButtonFocused] = useState(false);
  const [historyButtonFocused, setHistoryButtonFocused] = useState(false);
  const [settingsButtonFocused, setSettingsButtonFocused] = useState(false);
  // Cold-start instant-paint: hydrate from sessionStorage (synchronous, no
  // network) so the cinematic hero renders the last-known on-air program in
  // the very first paint instead of flashing the off-air gradient for the
  // ~100–500 ms it takes the SSE handshake or HTTP primer to land. Cache TTL
  // is 60 s so position-derived math (`computeLiveBroadcastPosition`) can
  // never drift past the item's duration before fresh data overwrites it.
  const [broadcastCurrent, setBroadcastCurrent] = useState<BroadcastCurrent | null>(
    () => readLastBroadcast(),
  );
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  useEffect(() => {
    const onOnline  = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

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
  // Row 1: Continue Watching (only when there are in-progress videos)
  // Row 2+: Content categories, then Sermon Series.
  const rows = useMemo(() => [
    { key: "__live__", label: "Live", items: 1 },
    ...(continueWatching.length > 0 ? [{ key: "__continue__", label: "Continue Watching", items: continueWatching.length }] : []),
    ...(favorites.length > 0 ? [{ key: "__favorites__", label: "Saved", items: favorites.length }] : []),
    ...CATEGORIES.map((cat) => ({ key: cat, label: cat, items: (byCategory[cat] ?? []).length })),
    ...(series.length > 0 ? [{ key: "__series__", label: "Sermon Series", items: series.length }] : []),
  ].filter((r) => r.items > 0), [byCategory, series, continueWatching, favorites]);

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
          const id = item.youtubeId ?? item.videoId ?? item.id;
          // Pass the live-corrected broadcast position so the player joins at
          // the exact moment currently airing rather than the cached position.
          // isLive=true → no scrubber, no SPACE/pause hint, no manual controls.
          onPlay(id, "Temple TV", hlsUrl, computeLiveBroadcastPosition(), true);
        }
        return;
      }

      if (row.key === "__continue__") {
        const entry = continueWatching[itemIndex];
        if (entry) onPlay(entry.videoId, entry.title, entry.hlsUrl ?? undefined, entry.positionSecs);
        return;
      }

      if (row.key === "__favorites__") {
        const fav = favorites[itemIndex];
        if (fav) onPlay(fav.videoId, fav.title, fav.hlsUrl ?? undefined);
        return;
      }

      if (row.key === "__series__") {
        const s = series[itemIndex];
        if (s) onSeriesDetail(s);
        return;
      }

      const rowSermons = byCategory[row.key] ?? [];
      const sermon = rowSermons[itemIndex];
      if (sermon) {
        const related = rowSermons.filter((s) => s.videoId !== sermon.videoId);
        onDetails(sermon, related);
      }
    },
    [rows, byCategory, series, continueWatching, favorites, liveStatus, onPlay, onDetails, onSeriesDetail, broadcastCurrent, computeLiveBroadcastPosition],
  );

  const onHeaderSelect = useCallback(
    (itemIndex: number) => {
      if (itemIndex === 0) onNavigateSearch();
      else if (itemIndex === 1) onNavigateHistory();
      else if (itemIndex === 2) onNavigateSettings();
    },
    [onNavigateSearch, onNavigateHistory, onNavigateSettings],
  );

  const { focusRow, getFocusItem, focusZone, headerItem } = useTVNav({
    rowCount: rows.length,
    getRowItemCount,
    onSelect,
    enabled: true,
    headerItemCount: 3,
    onHeaderSelect,
  });

  const searchHeaderFocused = focusZone === "header" && headerItem === 0;
  const historyHeaderFocused = focusZone === "header" && headerItem === 1;
  const settingsHeaderFocused = focusZone === "header" && headerItem === 2;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "s" || e.key === "S") { e.preventDefault(); onNavigateSearch(); }
      if (e.key === "h" || e.key === "H") { e.preventDefault(); onNavigateHistory(); }
      // Delete / Backspace while a Continue Watching card is focused → dismiss it.
      if (e.key === "Delete" || e.key === "Backspace") {
        if (focusZone !== "grid") return;
        const cwRowIdx = rows.findIndex((r) => r.key === "__continue__");
        if (cwRowIdx < 0 || focusRow !== cwRowIdx) return;
        const entry = continueWatching[getFocusItem(cwRowIdx)];
        if (entry) { e.preventDefault(); removeContinueWatching(entry.videoId); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNavigateSearch, onNavigateHistory, focusZone, focusRow, rows, getFocusItem, continueWatching, removeContinueWatching]);

  // Category rows start at index 1 (right after the live hero at index 0).
  // Offset shifts by 1 for each of: Continue Watching, Favorites rows when present.
  const catRowOffset = 1 + (continueWatching.length > 0 ? 1 : 0) + (favorites.length > 0 ? 1 : 0);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", background: "#070707" }}>

      {/* ── Emergency Broadcast Overlay ─────────────────────────────────────── */}
      {/* OMEGA: surfaced when the server sends an EMERGENCY_BROADCAST signal.
          Renders above all content including the hero and header — viewers
          see it immediately regardless of which row they are focused on. */}
      {liveSync.emergencyBroadcast && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            background: "rgba(200, 18, 18, 0.96)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            padding: "14px var(--tv-safe-h, 60px)",
            display: "flex",
            alignItems: "center",
            gap: 14,
            borderBottom: "1px solid rgba(255,120,120,0.35)",
            animation: "tv-emergency-slide-in 320ms cubic-bezier(0.2,0.6,0.2,1)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 0 10px rgba(255,255,255,0.8)",
              animation: "tv-emergency-pulse 0.7s ease-in-out infinite alternate",
              flexShrink: 0,
            }}
          />
          <span style={{ color: "#fff", fontSize: 15, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0 }}>
            Emergency Broadcast
          </span>
          {liveSync.emergencyMessage && (
            <span style={{ color: "rgba(255,255,255,0.88)", fontSize: 14, fontWeight: 400, borderLeft: "1px solid rgba(255,255,255,0.3)", paddingLeft: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {liveSync.emergencyMessage}
            </span>
          )}
          <style>{`
            @keyframes tv-emergency-pulse { from { opacity: 1; } to { opacity: 0.3; } }
            @keyframes tv-emergency-slide-in { from { opacity: 0; transform: translateY(-100%); } to { opacity: 1; transform: translateY(0); } }
          `}</style>
        </div>
      )}

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
          padding: "22px var(--tv-safe-h, 60px) 36px",
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
            <span className="tt-btn-label">Search</span>
          </button>

          <button
            onClick={onNavigateHistory}
            onFocus={() => setHistoryButtonFocused(true)}
            onBlur={() => setHistoryButtonFocused(false)}
            title="Watch History (H)"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10,
              background: (historyButtonFocused || historyHeaderFocused) ? "rgba(106,13,173,0.5)" : "rgba(255,255,255,0.08)",
              border: `1px solid ${(historyButtonFocused || historyHeaderFocused) ? "rgba(106,13,173,0.7)" : "rgba(255,255,255,0.15)"}`,
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
              outline: historyHeaderFocused ? "2px solid rgba(106,13,173,0.9)" : "none",
              outlineOffset: 2,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            <span className="tt-btn-label">History</span>
          </button>

          <button
            onClick={onNavigateSettings}
            onFocus={() => setSettingsButtonFocused(true)}
            onBlur={() => setSettingsButtonFocused(false)}
            title="Settings"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10,
              background: (settingsButtonFocused || settingsHeaderFocused) ? "rgba(106,13,173,0.5)" : "rgba(255,255,255,0.08)",
              border: `1px solid ${(settingsButtonFocused || settingsHeaderFocused) ? "rgba(106,13,173,0.7)" : "rgba(255,255,255,0.15)"}`,
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
              outline: settingsHeaderFocused ? "2px solid rgba(106,13,173,0.9)" : "none",
              outlineOffset: 2,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span className="tt-btn-label">Settings</span>
          </button>

          <Clock />
        </div>
      </div>

      {/* Offline connectivity banner — appears when browser loses network */}
      {!isOnline && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            top: 0, left: 0, right: 0,
            zIndex: 95,
            background: "rgba(15,15,15,0.96)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            padding: "10px var(--tv-safe-h, 60px)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            animation: "tv-emergency-slide-in 280ms cubic-bezier(0.2,0.6,0.2,1)",
          }}
        >
          <div
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "#f87171", flexShrink: 0,
              boxShadow: "0 0 8px rgba(248,113,113,0.6)",
              animation: "tv-emergency-pulse 1.5s ease-in-out infinite alternate",
            }}
          />
          <span style={{ color: "rgba(255,255,255,0.88)", fontSize: 14, fontWeight: 600, letterSpacing: "0.01em" }}>
            No internet connection
          </span>
          <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, borderLeft: "1px solid rgba(255,255,255,0.15)", paddingLeft: 12 }}>
            Showing cached content
          </span>
        </div>
      )}

      {/* NOW ON AIR + UP NEXT strip — overlays the hero so viewers always
          see what's airing now and what's next, even before they interact. */}
      <BroadcastOnAirStrip liveStatus={liveStatus} broadcastCurrent={broadcastCurrent} />

      {/* Scrollable content */}
      <div ref={scrollRef} style={{ position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden", paddingBottom: "max(40px, calc(var(--mobile-nav-h) + env(safe-area-inset-bottom, 0px) + 12px))" }}>
        {/* Hero */}
        <div style={{ marginBottom: 24 }}>
          <LiveHero
            liveStatus={liveStatus}
            broadcastCurrent={broadcastCurrent}
            focused={focusRow === 0}
            viewerCount={liveSync.viewerCount}
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
                const id = item.youtubeId ?? item.videoId ?? item.id;
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
                <div className="skeleton" style={{ width: 180, height: 22, marginBottom: 16, borderRadius: 6 }} />
                <div style={{ display: "flex", gap: 18 }}>
                  {[0, 1, 2, 3, 4].map((j) => (
                    <div key={j} style={{ flexShrink: 0 }}>
                      <div className="skeleton" style={{ width: 348, height: 196, borderRadius: 14 }} />
                      <div className="skeleton" style={{ width: 220, height: 14, marginTop: 10, borderRadius: 4 }} />
                      <div className="skeleton" style={{ width: 80, height: 12, marginTop: 6, borderRadius: 4 }} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : error && sermons.length === 0 ? (
          <div
            style={{
              paddingLeft: "var(--tv-safe-h, 60px)",
              paddingTop: 40,
              display: "flex",
              flexDirection: "column",
              gap: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div>
                <p style={{ fontSize: 20, fontWeight: 700, color: "rgba(255,255,255,0.9)", marginBottom: 6 }}>
                  Could not load content
                </p>
                <p style={{ fontSize: 15, color: "rgba(255,255,255,0.45)", maxWidth: 480 }}>
                  Check your connection and press <kbd style={{ background: "rgba(255,255,255,0.12)", borderRadius: 4, padding: "1px 7px", fontSize: 13, fontFamily: "monospace" }}>SELECT</kbd> to retry.
                </p>
              </div>
            </div>
          </div>
        ) : !loading && !error && sermons.length === 0 && continueWatching.length === 0 && favorites.length === 0 ? (
          <div style={{ paddingLeft: "var(--tv-safe-h, 60px)", paddingTop: 60 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 520 }}>
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              <p style={{ fontSize: 22, fontWeight: 700, color: "rgba(255,255,255,0.75)", margin: 0 }}>
                No content available
              </p>
              <p style={{ fontSize: 15, color: "rgba(255,255,255,0.35)", margin: 0, lineHeight: 1.6 }}>
                Videos will appear here once they are uploaded and processed by the admin team.
              </p>
            </div>
          </div>
        ) : (
          <div className={focusZone === "grid" ? "tv-rows-active" : ""}>

            {/* ── Continue Watching row ──────────────────────────────────── */}
            {continueWatching.length > 0 && (() => {
              const cwRowIdx = rows.findIndex((r) => r.key === "__continue__");
              if (cwRowIdx < 0) return null;
              const focusedIdx = getFocusItem(cwRowIdx);
              const rowFocused = focusRow === cwRowIdx;
              return (
                <div key="__continue__" style={{ marginBottom: 40, paddingLeft: "var(--tv-safe-h, 60px)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(168,85,247,0.85)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                    <h2 style={{ fontSize: 19, fontWeight: 700, color: "rgba(255,255,255,0.9)", letterSpacing: "-0.02em", margin: 0 }}>
                      Continue Watching
                    </h2>
                    {/* Dismiss hint — only visible when this row is focused */}
                    {rowFocused && (
                      <span style={{
                        marginLeft: 8, display: "flex", alignItems: "center", gap: 5,
                        background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 6, padding: "2px 8px",
                      }}>
                        <kbd style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "inherit", background: "none", border: "none", padding: 0 }}>DEL</kbd>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>Dismiss</span>
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 18, overflowX: "auto", scrollbarWidth: "none", paddingBottom: 4 }}>
                    {continueWatching.map((entry, idx) => {
                      const focused = rowFocused && focusedIdx === idx;
                      const pct = entry.durationSecs > 0
                        ? Math.min(100, Math.round((entry.positionSecs / entry.durationSecs) * 100))
                        : 0;
                      const thumb = entry.thumbnailUrl ||
                        (!entry.hlsUrl ? `https://img.youtube.com/vi/${entry.videoId}/mqdefault.jpg` : null);
                      const resumeLabel = (() => {
                        const s = Math.floor(entry.positionSecs);
                        const h = Math.floor(s / 3600);
                        const m = Math.floor((s % 3600) / 60);
                        const sec = s % 60;
                        if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
                        return `${m}:${String(sec).padStart(2, "0")}`;
                      })();
                      return (
                        <div
                          key={entry.videoId}
                          onClick={() => onPlay(entry.videoId, entry.title, entry.hlsUrl ?? undefined, entry.positionSecs)}
                          style={{
                            flexShrink: 0,
                            width: 220,
                            cursor: "pointer",
                            outline: focused ? "2px solid rgba(168,85,247,0.9)" : "none",
                            outlineOffset: 4,
                            borderRadius: 12,
                            transform: focused ? "scale(1.05)" : "scale(1)",
                            transition: "transform 0.15s ease",
                          }}
                        >
                          {/* Thumbnail with progress bar */}
                          <div style={{ width: 220, height: 132, borderRadius: 12, overflow: "hidden", position: "relative", background: "rgba(255,255,255,0.06)", marginBottom: 10 }}>
                            {thumb ? (
                              <img src={thumb} alt={entry.title} style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", background: "#000" }} loading="lazy" decoding="async" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            ) : (
                              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polygon points="5 3 19 12 5 21 5 3"/>
                                </svg>
                              </div>
                            )}
                            {/* Progress bar */}
                            {pct > 0 && (
                              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 4, background: "rgba(0,0,0,0.5)" }}>
                                <div style={{ width: `${pct}%`, height: "100%", background: "#a855f7", borderRadius: "0 2px 2px 0" }} />
                              </div>
                            )}
                            {/* Resume label overlay */}
                            <div style={{
                              position: "absolute", bottom: 8, left: 8,
                              background: "rgba(0,0,0,0.72)", borderRadius: 5,
                              padding: "2px 7px", fontSize: 11, fontWeight: 600,
                              color: "rgba(255,255,255,0.85)", display: "flex", alignItems: "center", gap: 4
                            }}>
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                              {resumeLabel}
                            </div>
                            {/* Dismiss × badge — appears on focus */}
                            {focused && (
                              <button
                                onClick={(e) => { e.stopPropagation(); removeContinueWatching(entry.videoId); }}
                                style={{
                                  position: "absolute", top: 6, right: 6,
                                  width: 24, height: 24, borderRadius: "50%",
                                  background: "rgba(0,0,0,0.75)", border: "1px solid rgba(255,255,255,0.25)",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  cursor: "pointer", padding: 0,
                                  transition: "background 0.15s",
                                }}
                                title="Remove from Continue Watching"
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="3" strokeLinecap="round">
                                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                              </button>
                            )}
                          </div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.9)", lineHeight: 1.3, marginBottom: 4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                            {entry.title}
                          </p>
                          {pct > 0 && (
                            <p style={{ fontSize: 11, color: "rgba(168,85,247,0.7)", fontWeight: 600 }}>{pct}% watched</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* ── Saved Favorites row ───────────────────────────────────── */}
            {favorites.length > 0 && (() => {
              const favRowIdx = rows.findIndex((r) => r.key === "__favorites__");
              if (favRowIdx < 0) return null;
              const focusedIdx = getFocusItem(favRowIdx);
              const rowFocused = focusRow === favRowIdx;
              return (
                <div key="__favorites__" style={{ marginBottom: 40, paddingLeft: "var(--tv-safe-h, 60px)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="rgba(168,85,247,0.85)" stroke="none">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    <h2 style={{ fontSize: 19, fontWeight: 700, color: "rgba(255,255,255,0.9)", letterSpacing: "-0.02em", margin: 0 }}>
                      Saved
                    </h2>
                  </div>
                  <div style={{ display: "flex", gap: 18, overflowX: "auto", scrollbarWidth: "none", paddingBottom: 4 }}>
                    {favorites.map((fav, idx) => {
                      const focused = rowFocused && focusedIdx === idx;
                      return (
                        <div
                          key={fav.videoId}
                          onClick={() => onPlay(fav.videoId, fav.title, fav.hlsUrl ?? undefined)}
                          style={{
                            flexShrink: 0,
                            width: 220,
                            cursor: "pointer",
                            outline: focused ? "2px solid rgba(168,85,247,0.9)" : "none",
                            outlineOffset: 4,
                            borderRadius: 12,
                            transform: focused ? "scale(1.05)" : "scale(1)",
                            transition: "transform 0.15s ease",
                          }}
                        >
                          <div style={{ width: 220, height: 132, borderRadius: 12, overflow: "hidden", position: "relative", background: "rgba(255,255,255,0.06)", marginBottom: 10 }}>
                            {fav.thumbnailUrl ? (
                              <img src={fav.thumbnailUrl} alt={fav.title} style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", background: "#000" }} loading="lazy" decoding="async" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            ) : (
                              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polygon points="5 3 19 12 5 21 5 3"/>
                                </svg>
                              </div>
                            )}
                            {focused && (
                              <div style={{ position: "absolute", inset: 0, background: "rgba(106,13,173,0.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="rgba(255,255,255,0.9)"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                              </div>
                            )}
                          </div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.9)", lineHeight: 1.3, marginBottom: 4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                            {fav.title}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

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
                  onSeeAll={rowSermons.length > 0 ? () => onCategoryPage(cat, rowSermons) : undefined}
                />
              );
            })}

            {/* ── Sermon Series row ──────────────────────────────────────── */}
            {series.length > 0 && (() => {
              const seriesRowIdx = rows.findIndex((r) => r.key === "__series__");
              if (seriesRowIdx < 0) return null;
              const focusedIdx = getFocusItem(seriesRowIdx);
              const rowFocused = focusRow === seriesRowIdx;
              return (
                <div key="__series__" style={{ marginBottom: 40, paddingLeft: "var(--tv-safe-h, 60px)" }}>
                  <h2 style={{ fontSize: 19, fontWeight: 700, color: "rgba(255,255,255,0.9)", marginBottom: 16, letterSpacing: "-0.02em" }}>
                    Sermon Series
                  </h2>
                  <div style={{ display: "flex", gap: 18, overflowX: "auto", scrollbarWidth: "none", paddingBottom: 4 }}>
                    {series.map((s: SeriesItem, idx: number) => {
                      const focused = rowFocused && focusedIdx === idx;
                      return (
                        <div
                          key={s.id}
                          onClick={() => onSeriesDetail(s)}
                          style={{
                            flexShrink: 0,
                            width: 200,
                            cursor: "pointer",
                            outline: focused ? "2px solid rgba(106,13,173,0.9)" : "none",
                            outlineOffset: 4,
                            borderRadius: 12,
                            transform: focused ? "scale(1.05)" : "scale(1)",
                            transition: "transform 0.15s ease",
                          }}
                        >
                          <div style={{ width: 200, height: 120, borderRadius: 12, overflow: "hidden", position: "relative", background: "rgba(255,255,255,0.06)", marginBottom: 10 }}>
                            {s.thumbnailUrl ? (
                              <img src={s.thumbnailUrl} alt={s.title} style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", background: "#000" }} loading="lazy" decoding="async" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            ) : (
                              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                              </div>
                            )}
                            {s.isOngoing && (
                              <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(34,197,94,0.85)", borderRadius: 4, padding: "2px 7px", fontSize: 10, fontWeight: 700, color: "#fff", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                                Ongoing
                              </div>
                            )}
                          </div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.9)", lineHeight: 1.3, marginBottom: 4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                            {s.title}
                          </p>
                          {s.preacher && (
                            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {s.preacher}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        <div style={{ paddingLeft: 60, paddingTop: 16 }}>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>
            ↑ ↓ Navigate rows &nbsp;·&nbsp; ← → Select &nbsp;·&nbsp; ENTER Open &nbsp;·&nbsp; S Search &nbsp;·&nbsp; H History
          </p>
        </div>
        {/* Always-on chat overlay, collapsed by default so it doesn't compete
            with the home grid; one tap expands. */}
        <ChatOverlay compact />
      </div>

      {/* Mobile bottom navigation — hidden on Smart TVs via .tt-mobile-nav CSS */}
      <MobileBottomNav
        onWatch={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
        onLibrary={onNavigateHistory}
        onLive={() => {
          if (liveStatus?.isLive && liveStatus.videoId) {
            onPlay(liveStatus.videoId, BROADCAST_TITLE, undefined, undefined, true);
          } else if (broadcastCurrent?.item) {
            const item = broadcastCurrent.item;
            const hlsUrl = item.localVideoUrl ?? undefined;
            const id = item.youtubeId ?? item.videoId ?? item.id;
            onPlay(id, "Temple TV", hlsUrl, computeLiveBroadcastPosition(), true);
          } else {
            scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        onSearch={onNavigateSearch}
        onSettings={onNavigateSettings}
        hasLive={liveStatus?.isLive ?? false}
      />
    </div>
  );
}
