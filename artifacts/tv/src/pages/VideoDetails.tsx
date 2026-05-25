import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoItem } from "../lib/api";
import { keyEventToAction } from "../lib/tvKeys";
import { getProgress } from "../lib/watchProgress";
import { useFavorites } from "../hooks/useFavorites";

interface VideoDetailsProps {
  video: VideoItem;
  relatedVideos: VideoItem[];
  /** startSecs is undefined for "play from beginning", or a position to resume from. */
  onPlay: (startSecs?: number) => void;
  onBack: () => void;
  onPlayRelated: (videoId: string, title: string, hlsUrl?: string) => void;
}

export function VideoDetails({ video, relatedVideos, onPlay, onBack, onPlayRelated }: VideoDetailsProps) {
  const [focused, setFocused] = useState<"play" | "fav" | "related">("play");
  // When the video has saved progress, the play-area has two buttons:
  // "Resume" (default) and "Play from beginning". playFocus tracks which
  // one is highlighted so D-pad can move between them before selecting.
  const [playFocus, setPlayFocus] = useState<"resume" | "restart">("resume");
  const [relatedIdx, setRelatedIdx] = useState(0);
  const relatedRef = useRef<(HTMLDivElement | null)[]>([]);

  // Read saved progress once on mount (sync localStorage read).
  const savedProgress = useMemo(() => getProgress(video.videoId), [video.videoId]);

  // Favorites
  const { isFav, toggle } = useFavorites();
  const isCurrentFav = isFav(video.videoId);

  useEffect(() => {
    if (focused === "related" && relatedRef.current[relatedIdx]) {
      relatedRef.current[relatedIdx]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [relatedIdx, focused]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);

      if (action === "back" || action === "exit") { e.preventDefault(); onBack(); return; }

      if (focused === "play") {
        if (action === "select") {
          e.preventDefault();
          if (savedProgress && playFocus === "resume") {
            onPlay(savedProgress.positionSecs);
          } else {
            onPlay(undefined);
          }
        } else if (savedProgress && action === "down" && playFocus === "resume") {
          e.preventDefault();
          setPlayFocus("restart");
        } else if (savedProgress && action === "up" && playFocus === "restart") {
          e.preventDefault();
          setPlayFocus("resume");
        } else if (action === "right") {
          // Move to favorite button
          e.preventDefault();
          setFocused("fav");
        } else if ((action === "down") && relatedVideos.length > 0) {
          if (savedProgress && playFocus === "resume") return;
          e.preventDefault();
          setFocused("related");
          setRelatedIdx(0);
        }
      } else if (focused === "fav") {
        if (action === "select") {
          e.preventDefault();
          toggle({
            videoId: video.videoId,
            title: video.title,
            thumbnailUrl: video.thumbnailUrl ?? "",
            hlsUrl: video.localVideoUrl ?? null,
          });
        } else if (action === "left") {
          e.preventDefault();
          setFocused("play");
        } else if (action === "down" && relatedVideos.length > 0) {
          e.preventDefault();
          setFocused("related");
          setRelatedIdx(0);
        }
      } else {
        if (action === "up" && relatedIdx === 0) { e.preventDefault(); setFocused("play"); }
        else if (action === "up") { e.preventDefault(); setRelatedIdx(i => Math.max(0, i - 1)); }
        else if (action === "down") { e.preventDefault(); setRelatedIdx(i => Math.min(relatedVideos.length - 1, i + 1)); }
        else if (action === "select") {
          e.preventDefault();
          const v = relatedVideos[relatedIdx];
          if (v) onPlayRelated(v.videoId, v.title, v.localVideoUrl ?? undefined);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focused, playFocus, savedProgress, relatedIdx, relatedVideos, onPlay, onBack, onPlayRelated, video, toggle]);

  const publishedDate = video.publishedAt
    ? new Date(video.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "";

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "#0a0a0f", position: "relative" }}>
      {video.thumbnailUrl && (
        <div style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden" }} aria-hidden="true">
          <img src={video.thumbnailUrl} alt="" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(40px) brightness(0.15)", transform: "scale(1.1)" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left panel: video info */}
        <div style={{ width: "55%", display: "flex", flexDirection: "column", padding: "40px 48px", overflow: "hidden" }}>
          <button
            onClick={onBack}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10, padding: "8px 16px", color: "rgba(255,255,255,0.8)", fontSize: 14, cursor: "pointer", fontFamily: "inherit", marginBottom: 32, alignSelf: "flex-start" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>

          {/* Thumbnail */}
          <div style={{ width: "100%", aspectRatio: "16/9", borderRadius: 16, overflow: "hidden", marginBottom: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.6)", flexShrink: 0 }}>
            {video.thumbnailUrl ? (
              <img src={video.thumbnailUrl} alt={video.title} decoding="async" style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", background: "#000" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            ) : (
              <div style={{ width: "100%", height: "100%", background: "rgba(106,13,173,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="rgba(168,85,247,0.5)"><rect x="2" y="2" width="20" height="20" rx="2"/></svg>
              </div>
            )}
          </div>

          {/* Metadata */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {video.duration && (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.08)", padding: "4px 10px", borderRadius: 6 }}>{video.duration}</span>
            )}
            {publishedDate && (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.08)", padding: "4px 10px", borderRadius: 6 }}>{publishedDate}</span>
            )}
            {video.viewCount && video.viewCount !== "0" && (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.08)", padding: "4px 10px", borderRadius: 6 }}>{Number(video.viewCount).toLocaleString()} views</span>
            )}
          </div>

          <h1 style={{ fontSize: 28, fontWeight: 800, color: "#fff", lineHeight: 1.2, marginBottom: 12, letterSpacing: "-0.01em" }}>
            {video.title}
          </h1>

          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.35)", marginBottom: 24, fontWeight: 600 }}>
            {video.channelName}
          </p>

          {video.description && (
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.6, marginBottom: 32, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical" as const }}>
              {video.description}
            </p>
          )}

          {/* Play / Resume buttons + Favorite */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignSelf: "flex-start" }}>
            {savedProgress ? (
              <>
                {(() => {
                  const pct = savedProgress.durationSecs > 0
                    ? Math.min(100, Math.round((savedProgress.positionSecs / savedProgress.durationSecs) * 100))
                    : 0;
                  const s = Math.floor(savedProgress.positionSecs);
                  const h = Math.floor(s / 3600);
                  const m = Math.floor((s % 3600) / 60);
                  const sec = s % 60;
                  const timeLabel = h > 0
                    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
                    : `${m}:${String(sec).padStart(2, "0")}`;
                  return (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: "rgba(168,85,247,0.8)", fontWeight: 600 }}>
                          {pct > 0 ? `${pct}% watched` : ""}
                        </span>
                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>{timeLabel} in</span>
                      </div>
                      <div style={{ height: 3, background: "rgba(255,255,255,0.12)", borderRadius: 2, overflow: "hidden", width: 260 }}>
                        {pct > 0 && <div style={{ width: `${pct}%`, height: "100%", background: "#a855f7", borderRadius: 2 }} />}
                      </div>
                    </div>
                  );
                })()}

                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {/* Resume button (primary) */}
                  <button
                    onClick={() => onPlay(savedProgress.positionSecs)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
                      padding: "18px 40px", borderRadius: 16,
                      background: focused === "play" && playFocus === "resume"
                        ? "linear-gradient(135deg, #7c3aed, #a855f7)"
                        : "rgba(255,255,255,0.1)",
                      border: `2px solid ${focused === "play" && playFocus === "resume" ? "#a855f7" : "rgba(255,255,255,0.15)"}`,
                      color: "#fff", fontSize: 20, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                      boxShadow: focused === "play" && playFocus === "resume"
                        ? "0 0 0 3px rgba(168,85,247,0.4), 0 8px 32px rgba(106,13,173,0.5)"
                        : "none",
                      transition: "all 0.2s ease",
                    }}
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Resume
                  </button>

                  {/* Favorite button */}
                  <button
                    onClick={() => toggle({ videoId: video.videoId, title: video.title, thumbnailUrl: video.thumbnailUrl ?? "", hlsUrl: video.localVideoUrl ?? null })}
                    title={isCurrentFav ? "Remove from favorites" : "Add to favorites"}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 52, height: 52, borderRadius: 14, flexShrink: 0,
                      background: isCurrentFav
                        ? "rgba(168,85,247,0.2)"
                        : focused === "fav"
                        ? "rgba(255,255,255,0.12)"
                        : "rgba(255,255,255,0.07)",
                      border: `2px solid ${focused === "fav" ? "rgba(168,85,247,0.6)" : isCurrentFav ? "rgba(168,85,247,0.4)" : "rgba(255,255,255,0.12)"}`,
                      boxShadow: focused === "fav" ? "0 0 0 3px rgba(168,85,247,0.25)" : "none",
                      cursor: "pointer", transition: "all 0.2s ease",
                    }}
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24"
                      fill={isCurrentFav ? "#a855f7" : "none"}
                      stroke={isCurrentFav ? "#a855f7" : "rgba(255,255,255,0.7)"}
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </button>
                </div>

                {/* Play from beginning (secondary) */}
                <button
                  onClick={() => onPlay(undefined)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                    padding: "12px 28px", borderRadius: 12,
                    background: focused === "play" && playFocus === "restart"
                      ? "rgba(255,255,255,0.15)"
                      : "rgba(255,255,255,0.05)",
                    border: `1px solid ${focused === "play" && playFocus === "restart" ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.1)"}`,
                    color: focused === "play" && playFocus === "restart" ? "#fff" : "rgba(255,255,255,0.5)",
                    fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                    boxShadow: focused === "play" && playFocus === "restart"
                      ? "0 0 0 2px rgba(255,255,255,0.2)"
                      : "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.63"/>
                  </svg>
                  Play from beginning
                </button>
              </>
            ) : (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {/* No saved progress — single Play Now button */}
                <button
                  onClick={() => onPlay(undefined)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
                    padding: "18px 40px", borderRadius: 16,
                    background: focused === "play" ? "linear-gradient(135deg, #7c3aed, #a855f7)" : "rgba(255,255,255,0.1)",
                    border: `2px solid ${focused === "play" ? "#a855f7" : "rgba(255,255,255,0.15)"}`,
                    color: "#fff", fontSize: 20, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                    boxShadow: focused === "play" ? "0 0 0 3px rgba(168,85,247,0.4), 0 8px 32px rgba(106,13,173,0.5)" : "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  Play Now
                </button>

                {/* Favorite button */}
                <button
                  onClick={() => toggle({ videoId: video.videoId, title: video.title, thumbnailUrl: video.thumbnailUrl ?? "", hlsUrl: video.localVideoUrl ?? null })}
                  title={isCurrentFav ? "Remove from favorites" : "Add to favorites"}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 52, height: 52, borderRadius: 14, flexShrink: 0,
                    background: isCurrentFav
                      ? "rgba(168,85,247,0.2)"
                      : focused === "fav"
                      ? "rgba(255,255,255,0.12)"
                      : "rgba(255,255,255,0.07)",
                    border: `2px solid ${focused === "fav" ? "rgba(168,85,247,0.6)" : isCurrentFav ? "rgba(168,85,247,0.4)" : "rgba(255,255,255,0.12)"}`,
                    boxShadow: focused === "fav" ? "0 0 0 3px rgba(168,85,247,0.25)" : "none",
                    cursor: "pointer", transition: "all 0.2s ease",
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24"
                    fill={isCurrentFav ? "#a855f7" : "none"}
                    stroke={isCurrentFav ? "#a855f7" : "rgba(255,255,255,0.7)"}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right panel: Up Next */}
        {relatedVideos.length > 0 && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", borderLeft: "1px solid rgba(255,255,255,0.08)", padding: "40px 40px", overflow: "hidden" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 20 }}>
              Up Next
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {relatedVideos.slice(0, 8).map((v, idx) => (
                <div
                  key={v.videoId}
                  ref={(el) => { relatedRef.current[idx] = el; }}
                  onClick={() => { setFocused("related"); setRelatedIdx(idx); onPlayRelated(v.videoId, v.title, v.localVideoUrl ?? undefined); }}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "12px",
                    borderRadius: 10,
                    cursor: "pointer",
                    marginBottom: 6,
                    transition: "all 0.15s ease",
                    background: focused === "related" && relatedIdx === idx ? "rgba(106,13,173,0.25)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${focused === "related" && relatedIdx === idx ? "rgba(168,85,247,0.4)" : "rgba(255,255,255,0.05)"}`,
                  }}
                >
                  <div style={{ width: 90, height: 52, borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
                    {v.thumbnailUrl ? (
                      <img src={v.thumbnailUrl} alt="" loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", background: "#000" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    ) : (
                      <div style={{ width: "100%", height: "100%", background: "rgba(106,13,173,0.3)" }} />
                    )}
                  </div>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: focused === "related" && relatedIdx === idx ? "#e9d5ff" : "rgba(255,255,255,0.8)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                      {v.title}
                    </div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>{v.duration}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom hint */}
      <div style={{ position: "relative", zIndex: 1, padding: "12px 48px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 24, flexShrink: 0 }}>
        {[
          { key: "ENTER", label: savedProgress ? (playFocus === "resume" ? "Resume" : "Play from beginning") : "Play" },
          { key: "→", label: "Favorite" },
          { key: "↑ ↓", label: savedProgress ? "Switch / Up Next" : "Up Next" },
          { key: "ESC", label: "Back" },
        ].map(h => (
          <div key={h.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <kbd style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 5, padding: "2px 7px", fontSize: 11, color: "rgba(255,255,255,0.6)", fontFamily: "inherit" }}>{h.key}</kbd>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>{h.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
