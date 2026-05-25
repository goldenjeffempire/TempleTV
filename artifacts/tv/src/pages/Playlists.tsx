/**
 * Playlists Page — Temple TV Smart TV
 *
 * Two-panel layout:
 *  Left: scrollable playlist grid
 *  Right (when a playlist is selected): episode list for that playlist
 *
 * D-pad navigable via standard focus management.
 * Follows the established TV design language (dark glass cards, purple
 * accent, 10-foot typography scale).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaylists, usePlaylistDetail } from "../hooks/usePlaylists";
import type { PlaylistItem, PlaylistVideo } from "../hooks/usePlaylists";
import { keyEventToAction } from "../lib/tvKeys";

interface PlaylistsProps {
  onBack: () => void;
  onPlay: (videoId: string, title: string, hlsUrl?: string, startSecs?: number, isLive?: boolean, thumbnailUrl?: string) => void;
}

function PlaylistCard({
  playlist,
  focused,
  selected,
  onClick,
}: {
  playlist: PlaylistItem;
  focused: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focused]);

  return (
    <div
      ref={ref}
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-selected={selected}
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: 14,
        overflow: "hidden",
        cursor: "pointer",
        outline: "none",
        transition: "all 0.15s ease",
        border: selected
          ? "2px solid rgba(168,85,247,0.9)"
          : focused
          ? "2px solid rgba(168,85,247,0.6)"
          : "2px solid rgba(255,255,255,0.08)",
        background: selected
          ? "rgba(106,13,173,0.25)"
          : focused
          ? "rgba(255,255,255,0.07)"
          : "rgba(255,255,255,0.04)",
        transform: focused ? "scale(1.03)" : "scale(1)",
        boxShadow: focused ? "0 8px 32px rgba(0,0,0,0.5)" : "none",
      }}
    >
      {/* Thumbnail */}
      <div style={{ position: "relative", paddingTop: "56.25%", background: "#111" }}>
        {playlist.thumbnailUrl ? (
          <img
            src={playlist.thumbnailUrl}
            alt={playlist.title}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg, #1a0533, #2d0a4e)",
            }}
          >
            <span style={{ fontSize: 36 }}>🎵</span>
          </div>
        )}
        {/* Video count badge */}
        <div
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            background: "rgba(0,0,0,0.75)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 6,
            letterSpacing: 0.3,
          }}
        >
          {playlist.videoCount} {playlist.videoCount === 1 ? "video" : "videos"}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: "10px 12px", gap: 4, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1.3,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {playlist.title}
        </div>
        {playlist.category && (
          <div style={{ color: "rgba(168,85,247,0.9)", fontSize: 11, fontWeight: 600 }}>
            {playlist.category}
          </div>
        )}
      </div>
    </div>
  );
}

function EpisodeRow({
  video,
  index,
  focused,
  onPlay,
}: {
  video: PlaylistVideo;
  index: number;
  focused: boolean;
  onPlay: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focused]);

  return (
    <div
      ref={ref}
      onClick={onPlay}
      tabIndex={0}
      role="button"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 14px",
        borderRadius: 10,
        cursor: "pointer",
        outline: "none",
        transition: "all 0.12s ease",
        background: focused ? "rgba(106,13,173,0.35)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${focused ? "rgba(168,85,247,0.6)" : "rgba(255,255,255,0.06)"}`,
        transform: focused ? "translateX(4px)" : "none",
      }}
    >
      {/* Episode number */}
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: "rgba(106,13,173,0.4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: 12,
          fontWeight: 700,
          color: "rgba(168,85,247,0.9)",
        }}
      >
        {index + 1}
      </div>

      {/* Thumbnail */}
      <div
        style={{
          width: 80,
          height: 45,
          borderRadius: 6,
          overflow: "hidden",
          flexShrink: 0,
          background: "#1a1a2e",
        }}
      >
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 20 }}>▶</span>
          </div>
        )}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {video.title}
        </div>
        {video.preacher && (
          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, marginTop: 2 }}>
            {video.preacher}
            {video.duration ? ` · ${video.duration}` : ""}
          </div>
        )}
      </div>

      {/* Play icon */}
      {focused && (
        <div style={{ color: "rgba(168,85,247,0.9)", fontSize: 20, flexShrink: 0 }}>▶</div>
      )}
    </div>
  );
}

export function Playlists({ onBack, onPlay }: PlaylistsProps) {
  const { playlists, loading, error } = usePlaylists();
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistItem | null>(null);
  const [focusedGrid, setFocusedGrid] = useState(0);
  const [focusedEpisode, setFocusedEpisode] = useState(0);
  const [panel, setPanel] = useState<"grid" | "episodes">("grid");

  const { playlist: detail, loading: detailLoading } = usePlaylistDetail(selectedPlaylist?.id ?? null);

  const handleSelectPlaylist = useCallback((p: PlaylistItem) => {
    setSelectedPlaylist(p);
    setFocusedEpisode(0);
    setPanel("episodes");
  }, []);

  const handlePlay = useCallback((video: PlaylistVideo) => {
    const hlsUrl = video.hlsMasterUrl ?? video.localVideoUrl ?? undefined;
    onPlay(video.id, video.title, hlsUrl, undefined, undefined, video.thumbnailUrl || undefined);
  }, [onPlay]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const action = keyEventToAction(e);
      if (!action) return;

      if (panel === "grid") {
        const cols = 3;
        if (action === "up") {
          if (focusedGrid < cols) { onBack(); return; }
          setFocusedGrid((f) => Math.max(0, f - cols));
        } else if (action === "down") {
          setFocusedGrid((f) => Math.min(playlists.length - 1, f + cols));
        } else if (action === "left") {
          setFocusedGrid((f) => Math.max(0, f - 1));
        } else if (action === "right") {
          if (selectedPlaylist && focusedGrid === playlists.length - 1) {
            setPanel("episodes");
          } else {
            setFocusedGrid((f) => Math.min(playlists.length - 1, f + 1));
          }
        } else if (action === "select") {
          if (playlists[focusedGrid]) handleSelectPlaylist(playlists[focusedGrid]);
        } else if (action === "back") {
          onBack();
        }
      } else {
        const eps = detail?.videos ?? [];
        if (action === "up") {
          if (focusedEpisode === 0) setPanel("grid");
          else setFocusedEpisode((f) => Math.max(0, f - 1));
        } else if (action === "down") {
          setFocusedEpisode((f) => Math.min(eps.length - 1, f + 1));
        } else if (action === "left") {
          setPanel("grid");
        } else if (action === "select") {
          if (eps[focusedEpisode]) handlePlay(eps[focusedEpisode]);
        } else if (action === "back") {
          setPanel("grid");
        }
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [panel, focusedGrid, focusedEpisode, playlists, detail, selectedPlaylist, handleSelectPlaylist, handlePlay, onBack]);

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        background: "#080812",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "18px 32px",
          background: "rgba(255,255,255,0.03)",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            width: 42,
            height: 42,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "#fff",
            fontSize: 18,
          }}
        >
          ←
        </button>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: -0.5 }}>
            Playlists
          </h1>
          {!loading && !error && (
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginTop: 2 }}>
              {playlists.length} {playlists.length === 1 ? "playlist" : "playlists"}
            </div>
          )}
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left: Playlist grid */}
        <div
          style={{
            width: selectedPlaylist ? "42%" : "100%",
            overflowY: "auto",
            padding: "20px 24px",
            transition: "width 0.3s ease",
            borderRight: selectedPlaylist ? "1px solid rgba(255,255,255,0.07)" : "none",
          }}
        >
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, gap: 12, color: "rgba(255,255,255,0.4)", flexDirection: "column" }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  border: "3px solid rgba(255,255,255,0.1)",
                  borderTopColor: "#a855f7",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              <span>Loading playlists…</span>
            </div>
          ) : error ? (
            <div style={{ color: "rgba(239,68,68,0.8)", textAlign: "center", padding: 40 }}>
              Failed to load playlists
            </div>
          ) : playlists.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,0.3)" }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🎵</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: "rgba(255,255,255,0.6)" }}>
                No Playlists Yet
              </div>
              <div style={{ fontSize: 14 }}>Playlists will appear here once created by the admin.</div>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: selectedPlaylist ? "1fr 1fr" : "repeat(3, 1fr)",
                gap: 16,
                transition: "grid-template-columns 0.3s ease",
              }}
            >
              {playlists.map((p, i) => (
                <PlaylistCard
                  key={p.id}
                  playlist={p}
                  focused={panel === "grid" && focusedGrid === i}
                  selected={selectedPlaylist?.id === p.id}
                  onClick={() => handleSelectPlaylist(p)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right: Episode list */}
        {selectedPlaylist && (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "20px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {/* Playlist header */}
            <div>
              <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, letterSpacing: -0.3 }}>
                {selectedPlaylist.title}
              </h2>
              {selectedPlaylist.description && (
                <p style={{ margin: "0 0 4px", fontSize: 13, color: "rgba(255,255,255,0.5)", lineHeight: 1.5 }}>
                  {selectedPlaylist.description}
                </p>
              )}
              <span style={{ fontSize: 12, color: "rgba(168,85,247,0.8)", fontWeight: 600 }}>
                {selectedPlaylist.videoCount} {selectedPlaylist.videoCount === 1 ? "video" : "videos"}
              </span>
            </div>

            {/* Episodes */}
            {detailLoading ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 120, color: "rgba(255,255,255,0.4)" }}>
                Loading episodes…
              </div>
            ) : !detail?.videos?.length ? (
              <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,0.3)" }}>
                No videos in this playlist yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {detail.videos.map((video, i) => (
                  <EpisodeRow
                    key={video.id}
                    video={video}
                    index={i}
                    focused={panel === "episodes" && focusedEpisode === i}
                    onPlay={() => handlePlay(video)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
