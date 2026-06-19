import { useCallback, useEffect, useRef, useState } from "react";
import { resolveApiOrigin } from "../lib/api";
import { keyEventToAction } from "../lib/tvKeys";
import { getProgress } from "../lib/watchProgress";
import type { VideoItem } from "../lib/api";
import type { SeriesItem } from "../hooks/useSeries";

interface EpisodeEntry {
  id: string;
  episodeNumber: number;
  title: string | null;
  description: string | null;
  thumbnailUrl: string;
  youtubeId: string | null;
  hlsMasterUrl: string | null;
  localVideoUrl: string | null;
  duration: string;
  viewCount: number;
  category: string;
  videoId: string;
  youtubeLiveStatus?: "live" | "rebroadcast" | null;
}

interface SeriesDetailProps {
  series: SeriesItem;
  onBack: () => void;
  /** startSecs is the saved resume position — omit to start from the beginning. */
  onPlay: (videoId: string, title: string, hlsUrl?: string, startSecs?: number) => void;
  onEpisodeDetails: (video: VideoItem, related: VideoItem[]) => void;
}

type FocusZone = "play" | "episodes";

function episodeToVideoItem(ep: EpisodeEntry, series: SeriesItem): VideoItem {
  return {
    videoId: ep.youtubeId ?? ep.videoId,
    title: ep.title ?? series.title,
    description: ep.description ?? series.description ?? "",
    publishedAt: "",
    thumbnailUrl: ep.thumbnailUrl || series.thumbnailUrl,
    channelName: series.preacher ?? "Temple TV",
    duration: ep.duration ?? "",
    viewCount: String(ep.viewCount ?? 0),
    videoSource: ep.youtubeId ? "youtube" as const : "local" as const,
    localVideoUrl: ep.hlsMasterUrl ?? ep.localVideoUrl ?? null,
    apiCategory: ep.category ?? series.category,
  };
}

function EpisodeCard({
  ep,
  index: _index,
  focused,
  onClick,
  savedProgress,
}: {
  ep: EpisodeEntry;
  index: number;
  focused: boolean;
  onClick: () => void;
  savedProgress?: { positionSecs: number; durationSecs: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focused]);

  const thumb =
    ep.thumbnailUrl ||
    (ep.youtubeId ? `https://img.youtube.com/vi/${ep.youtubeId}/mqdefault.jpg` : null);

  const progressPct = savedProgress && savedProgress.durationSecs > 0
    ? Math.min(100, Math.round((savedProgress.positionSecs / savedProgress.durationSecs) * 100))
    : (savedProgress ? 1 : 0); // show a tiny sliver even if duration is unknown

  const resumeLabel = savedProgress ? (() => {
    const s = Math.floor(savedProgress.positionSecs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  })() : null;

  return (
    <div
      ref={ref}
      role="button"
      onClick={onClick}
      style={{
        display: "flex",
        gap: 14,
        padding: "12px 14px",
        borderRadius: 12,
        cursor: "pointer",
        marginBottom: 6,
        transition: "all 0.15s ease",
        background: focused ? "rgba(106,13,173,0.28)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${focused ? "rgba(168,85,247,0.5)" : "rgba(255,255,255,0.06)"}`,
        boxShadow: focused ? "0 0 0 2px rgba(168,85,247,0.2)" : "none",
        flexShrink: 0,
      }}
    >
      {/* Episode number badge */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: focused ? "rgba(168,85,247,0.4)" : "rgba(255,255,255,0.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
          color: focused ? "#e9d5ff" : "rgba(255,255,255,0.4)",
          flexShrink: 0,
          alignSelf: "center",
        }}
      >
        {ep.episodeNumber}
      </div>

      {/* Thumbnail */}
      <div
        style={{
          width: 96,
          height: 56,
          borderRadius: 8,
          overflow: "hidden",
          flexShrink: 0,
          background: "rgba(255,255,255,0.06)",
          position: "relative",
        }}
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top", background: "#000" }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        )}
        {/* Progress bar at bottom of thumbnail */}
        {progressPct > 0 && (
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, background: "rgba(0,0,0,0.5)" }}>
            <div style={{ width: `${progressPct}%`, height: "100%", background: "#a855f7" }} />
          </div>
        )}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: focused ? "#e9d5ff" : "rgba(255,255,255,0.82)",
              lineHeight: 1.3,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical" as const,
            }}
          >
            {ep.title ?? `Episode ${ep.episodeNumber}`}
          </div>
          {ep.youtubeLiveStatus === "live" && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#dc2626", borderRadius: 20, padding: "1px 7px", fontSize: 9, fontWeight: 700, color: "#fff", letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#fff", animation: "yt-live-pulse 1.4s ease-in-out infinite", flexShrink: 0 }} />
              LIVE
            </span>
          )}
          {ep.youtubeLiveStatus === "rebroadcast" && (
            <span style={{ display: "inline-flex", alignItems: "center", background: "#d97706", borderRadius: 20, padding: "1px 7px", fontSize: 9, fontWeight: 700, color: "#fff", letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0 }}>
              REBROADCAST
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {ep.duration && (
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.32)" }}>
              {ep.duration}
            </div>
          )}
          {resumeLabel && (
            <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "rgba(168,85,247,0.75)", fontWeight: 600 }}>
              <svg width="7" height="7" viewBox="0 0 24 24" fill="rgba(168,85,247,0.75)"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              {resumeLabel}
            </div>
          )}
        </div>
      </div>

      {/* Play chevron when focused */}
      {focused && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#a855f7",
            flexShrink: 0,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
      )}
    </div>
  );
}

export function SeriesDetail({ series, onBack, onPlay, onEpisodeDetails }: SeriesDetailProps) {
  const [episodes, setEpisodes] = useState<EpisodeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [zone, setZone] = useState<FocusZone>("play");
  const [epIdx, setEpIdx] = useState(0);

  // Fetch episodes on mount
  useEffect(() => {
    const origin = resolveApiOrigin();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    fetch(`${origin}/api/series/${series.slug}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        const raw = (data.episodes ?? []) as Array<{
          id: string;
          episodeNumber: number;
          title: string | null;
          description: string | null;
          videoId: string;
          addedAt: string;
          // These come from the joined video row (if server expands them)
          thumbnailUrl?: string;
          youtubeId?: string | null;
          hlsMasterUrl?: string | null;
          localVideoUrl?: string | null;
          duration?: string;
          viewCount?: number;
          category?: string;
        }>;
        const mapped: EpisodeEntry[] = raw.map((e) => ({
          id: e.id,
          episodeNumber: e.episodeNumber,
          title: e.title ?? null,
          description: e.description ?? null,
          thumbnailUrl: e.thumbnailUrl ?? "",
          youtubeId: e.youtubeId ?? null,
          hlsMasterUrl: e.hlsMasterUrl ?? null,
          localVideoUrl: e.localVideoUrl ?? null,
          duration: e.duration ?? "",
          viewCount: e.viewCount ?? 0,
          category: e.category ?? series.category,
          videoId: e.videoId,
        }));
        setEpisodes(mapped.sort((a, b) => a.episodeNumber - b.episodeNumber));
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(true);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        setLoading(false);
      });
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [series.slug, series.category]);

  const playEpisode = useCallback(
    (ep: EpisodeEntry) => {
      const videoId = ep.youtubeId ?? ep.videoId;
      const hlsUrl = ep.hlsMasterUrl ?? ep.localVideoUrl ?? undefined;
      // Resume from saved position if available — uses the resolved videoId
      // (youtubeId preferred) so the key matches what was saved during playback.
      const saved = getProgress(videoId);
      onPlay(videoId, ep.title ?? series.title, hlsUrl, saved?.positionSecs);
    },
    [onPlay, series.title],
  );

  const openEpisodeDetails = useCallback(
    (ep: EpisodeEntry, allEps: EpisodeEntry[]) => {
      const video = episodeToVideoItem(ep, series);
      const related = allEps
        .filter((e) => e.id !== ep.id)
        .map((e) => episodeToVideoItem(e, series));
      onEpisodeDetails(video, related);
    },
    [onEpisodeDetails, series],
  );

  // D-pad keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);
      if (!action) return;

      if (action === "back" || action === "exit") {
        e.preventDefault();
        onBack();
        return;
      }

      if (zone === "play") {
        if (action === "select") {
          e.preventDefault();
          const first = episodes[0];
          if (first) playEpisode(first);
        } else if (action === "right" || action === "down") {
          if (episodes.length > 0) {
            e.preventDefault();
            setZone("episodes");
            setEpIdx(0);
          }
        }
      } else {
        // zone === "episodes"
        if (action === "up" && epIdx === 0) {
          e.preventDefault();
          setZone("play");
        } else if (action === "up") {
          e.preventDefault();
          setEpIdx((i) => Math.max(0, i - 1));
        } else if (action === "down") {
          e.preventDefault();
          setEpIdx((i) => Math.min(episodes.length - 1, i + 1));
        } else if (action === "select") {
          e.preventDefault();
          const ep = episodes[epIdx];
          if (ep) openEpisodeDetails(ep, episodes);
        } else if (action === "left") {
          e.preventDefault();
          setZone("play");
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [zone, epIdx, episodes, onBack, playEpisode, openEpisodeDetails]);

  const firstEp = episodes[0];

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#07070c",
        position: "relative",
      }}
    >
      {/* Ambient backdrop — blurred series art */}
      {series.thumbnailUrl && (
        <div
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden" }}
        >
          <img
            src={series.thumbnailUrl}
            alt=""
            decoding="async"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "blur(50px) brightness(0.12) saturate(1.4)",
              transform: "scale(1.15)",
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        </div>
      )}

      {/* Content layer */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* ── Left panel: series hero ─────────────────────────────────────── */}
        <div
          style={{
            width: "44%",
            display: "flex",
            flexDirection: "column",
            padding: "36px 48px",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {/* Back button */}
          <button
            onClick={onBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.13)",
              borderRadius: 10,
              padding: "8px 16px",
              color: "rgba(255,255,255,0.75)",
              fontSize: 14,
              cursor: "pointer",
              fontFamily: "inherit",
              marginBottom: 28,
              alignSelf: "flex-start",
              transition: "background 0.15s",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </button>

          {/* Series artwork */}
          <div
            style={{
              width: "100%",
              aspectRatio: "16/9",
              borderRadius: 16,
              overflow: "hidden",
              marginBottom: 24,
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
              flexShrink: 0,
              background: "rgba(106,13,173,0.18)",
            }}
          >
            {series.thumbnailUrl ? (
              <img
                src={series.thumbnailUrl}
                alt={series.title}
                decoding="async"
                style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top", background: "#000" }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "linear-gradient(135deg, rgba(106,13,173,0.4), rgba(10,0,20,0.8))",
                }}
              >
                <svg
                  width="52"
                  height="52"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgba(168,85,247,0.45)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              </div>
            )}
          </div>

          {/* Badges row */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            {series.isOngoing && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#4ade80",
                  background: "rgba(74,222,128,0.12)",
                  border: "1px solid rgba(74,222,128,0.25)",
                  padding: "3px 9px",
                  borderRadius: 6,
                }}
              >
                Ongoing
              </span>
            )}
            {series.category && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "capitalize",
                  color: "rgba(255,255,255,0.45)",
                  background: "rgba(255,255,255,0.07)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  padding: "3px 9px",
                  borderRadius: 6,
                }}
              >
                {series.category}
              </span>
            )}
            {episodes.length > 0 && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.45)",
                  background: "rgba(255,255,255,0.07)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  padding: "3px 9px",
                  borderRadius: 6,
                }}
              >
                {episodes.length} episode{episodes.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Title */}
          <h1
            style={{
              fontSize: 30,
              fontWeight: 800,
              color: "#fff",
              lineHeight: 1.15,
              marginBottom: 8,
              letterSpacing: "-0.02em",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical" as const,
            }}
          >
            {series.title}
          </h1>

          {/* Preacher */}
          {series.preacher && (
            <p
              style={{
                fontSize: 14,
                color: "rgba(255,255,255,0.38)",
                marginBottom: 16,
                fontWeight: 600,
              }}
            >
              {series.preacher}
            </p>
          )}

          {/* Description */}
          {series.description && (
            <p
              style={{
                fontSize: 13,
                color: "rgba(255,255,255,0.48)",
                lineHeight: 1.65,
                marginBottom: 28,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical" as const,
                flex: 1,
              }}
            >
              {series.description}
            </p>
          )}

          {/* Play from Episode 1 CTA */}
          {firstEp && (
            <button
              onClick={() => playEpisode(firstEp)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                padding: "18px 32px",
                borderRadius: 16,
                background:
                  zone === "play"
                    ? "linear-gradient(135deg, #7c3aed, #a855f7)"
                    : "rgba(255,255,255,0.08)",
                border: `2px solid ${zone === "play" ? "#a855f7" : "rgba(255,255,255,0.13)"}`,
                color: "#fff",
                fontSize: 18,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
                boxShadow:
                  zone === "play"
                    ? "0 0 0 3px rgba(168,85,247,0.35), 0 10px 40px rgba(106,13,173,0.5)"
                    : "none",
                transition: "all 0.2s ease",
                alignSelf: "flex-start",
                outline: "none",
                whiteSpace: "nowrap",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Play from Episode 1
            </button>
          )}

          {/* No episodes / loading states */}
          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                color: "rgba(255,255,255,0.3)",
                fontSize: 13,
                marginTop: 16,
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: "2px solid rgba(168,85,247,0.4)",
                  borderTopColor: "#a855f7",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              Loading episodes…
            </div>
          )}

          {error && (
            <p style={{ fontSize: 13, color: "rgba(255,100,100,0.7)", marginTop: 12 }}>
              Could not load episodes. Check your connection.
            </p>
          )}

          {!loading && !error && episodes.length === 0 && (
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", marginTop: 12 }}>
              No episodes published yet.
            </p>
          )}
        </div>

        {/* ── Right panel: episode list ───────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid rgba(255,255,255,0.07)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "24px 28px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              flexShrink: 0,
            }}
          >
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "rgba(255,255,255,0.3)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              All Episodes
            </p>
          </div>

          {/* Episodes scroll */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px 20px",
              scrollbarWidth: "none",
            }}
          >
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    style={{
                      height: 72,
                      borderRadius: 12,
                      background: "rgba(255,255,255,0.04)",
                      animation: "pulse 1.4s ease-in-out infinite",
                    }}
                  />
                ))}
              </div>
            ) : episodes.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "60%",
                  gap: 14,
                  opacity: 0.4,
                }}
              >
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)" }}>No episodes yet</p>
              </div>
            ) : (
              episodes.map((ep, idx) => {
                const resolvedId = ep.youtubeId ?? ep.videoId;
                const saved = getProgress(resolvedId);
                return (
                  <EpisodeCard
                    key={ep.id}
                    ep={ep}
                    index={idx}
                    focused={zone === "episodes" && epIdx === idx}
                    onClick={() => openEpisodeDetails(ep, episodes)}
                    savedProgress={saved}
                  />
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom hint bar ─────────────────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "10px 48px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          display: "flex",
          gap: 24,
          flexShrink: 0,
        }}
      >
        {[
          { key: "ENTER", label: zone === "play" ? "Play Ep. 1" : "Open" },
          { key: "↑ ↓", label: "Episodes" },
          { key: "→", label: "Episode list" },
          { key: "ESC", label: "Back" },
        ].map((h) => (
          <div key={h.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <kbd
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.13)",
                borderRadius: 5,
                padding: "2px 7px",
                fontSize: 11,
                color: "rgba(255,255,255,0.5)",
                fontFamily: "inherit",
              }}
            >
              {h.key}
            </kbd>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.28)" }}>{h.label}</span>
          </div>
        ))}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:0.4; } 50% { opacity:0.7; } }
      `}</style>
    </div>
  );
}
