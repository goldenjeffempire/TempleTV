import { useEffect, useRef, useState } from "react";
import { useWatchHistory } from "../hooks/useWatchHistory";

interface WatchHistoryProps {
  onBack: () => void;
  onPlay: (
    videoId: string,
    title: string,
    hlsUrl?: string,
    startSecs?: number,
  ) => void;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatTime(secs: number): string {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function WatchHistory({ onBack, onPlay }: WatchHistoryProps) {
  const { entries, clearAll } = useWatchHistory();
  const [focusIdx, setFocusIdx] = useState(0);
  const [clearConfirm, setClearConfirm] = useState(false);
  const focusedRef = useRef<HTMLDivElement>(null);

  // Keep focusIdx in-bounds when entries are cleared
  useEffect(() => {
    setFocusIdx((i) => Math.min(i, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  // Auto-scroll the focused card into view
  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusIdx]);

  // D-pad + keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Any non-C key while confirm is shown: cancel confirm (ESC also backs out)
      if (clearConfirm && e.key !== "c" && e.key !== "C") {
        setClearConfirm(false);
        if (e.key === "Escape" || e.key === "Backspace") {
          e.preventDefault();
          onBack();
        }
        return;
      }

      switch (e.key) {
        case "Escape":
        case "Backspace":
          e.preventDefault();
          onBack();
          break;
        case "ArrowUp":
          e.preventDefault();
          setClearConfirm(false);
          setFocusIdx((i) => Math.max(0, i - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setClearConfirm(false);
          setFocusIdx((i) => Math.min(entries.length - 1, i + 1));
          break;
        case "Enter": {
          e.preventDefault();
          setClearConfirm(false);
          const entry = entries[focusIdx];
          if (!entry) break;
          onPlay(
            entry.videoId,
            entry.title,
            entry.hlsUrl ?? undefined,
            entry.completed ? undefined : entry.positionSecs,
          );
          break;
        }
        case "c":
        case "C":
          e.preventDefault();
          if (entries.length === 0) break;
          if (clearConfirm) {
            clearAll();
            setClearConfirm(false);
          } else {
            setClearConfirm(true);
          }
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [entries, focusIdx, clearConfirm, clearAll, onBack, onPlay]);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "linear-gradient(135deg, #0a0a14 0%, #0f0714 100%)",
        color: "#fff",
      }}
    >
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "24px var(--tv-safe-h, 60px) 20px",
          display: "flex",
          alignItems: "center",
          gap: 20,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          flexShrink: 0,
        }}
      >
        {/* Back */}
        <button
          onClick={onBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            padding: "9px 16px",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "inherit",
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

        {/* Title */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgba(168,85,247,0.8)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Watch History
          </span>
          {entries.length > 0 && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "rgba(255,255,255,0.35)",
                background: "rgba(255,255,255,0.06)",
                borderRadius: 6,
                padding: "3px 8px",
                marginLeft: 2,
              }}
            >
              {entries.length}
            </span>
          )}
        </div>

        {/* Clear All / Confirmation */}
        {entries.length > 0 &&
          (clearConfirm ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 10,
                padding: "9px 18px",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ef4444"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span style={{ fontSize: 13, color: "#ef4444", fontWeight: 600 }}>
                Press C again to clear all
              </span>
            </div>
          ) : (
            <button
              onClick={() => setClearConfirm(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.2)",
                borderRadius: 10,
                padding: "9px 16px",
                color: "rgba(239,68,68,0.8)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              Clear All
            </button>
          ))}
      </div>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      {entries.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
          }}
        >
          <svg
            width="52"
            height="52"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgba(255,255,255,0.15)"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <p
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: "rgba(255,255,255,0.3)",
              margin: 0,
            }}
          >
            No watch history yet
          </p>
          <p
            style={{
              fontSize: 13,
              color: "rgba(255,255,255,0.18)",
              margin: 0,
            }}
          >
            Videos you watch will appear here
          </p>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "20px var(--tv-safe-h, 60px) 40px",
          }}
        >
          {entries.map((entry, idx) => {
            const focused = idx === focusIdx;
            const pct =
              entry.durationSecs > 0
                ? Math.min(
                    100,
                    Math.round(
                      (entry.positionSecs / entry.durationSecs) * 100,
                    ),
                  )
                : 0;
            const thumb =
              entry.thumbnailUrl ||
              (entry.videoId.length === 11
                ? `https://img.youtube.com/vi/${entry.videoId}/mqdefault.jpg`
                : null);

            return (
              <div
                key={entry.videoId}
                ref={focused ? focusedRef : undefined}
                role="button"
                onClick={() => {
                  setFocusIdx(idx);
                  onPlay(
                    entry.videoId,
                    entry.title,
                    entry.hlsUrl ?? undefined,
                    entry.completed ? undefined : entry.positionSecs,
                  );
                }}
                style={{
                  display: "flex",
                  gap: 16,
                  padding: "14px 16px",
                  borderRadius: 12,
                  marginBottom: 8,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  background: focused
                    ? "rgba(106,13,173,0.28)"
                    : "rgba(255,255,255,0.03)",
                  border: `1px solid ${focused ? "rgba(168,85,247,0.5)" : "rgba(255,255,255,0.06)"}`,
                  boxShadow: focused
                    ? "0 0 0 2px rgba(168,85,247,0.2)"
                    : "none",
                }}
              >
                {/* Thumbnail */}
                <div
                  style={{
                    width: 120,
                    height: 68,
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
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        objectPosition: "center",
                        background: "#000",
                      }}
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
                        width="22"
                        height="22"
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
                  {/* Progress bar — in-progress videos only */}
                  {!entry.completed && pct > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: 3,
                        background: "rgba(0,0,0,0.5)",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background: "#a855f7",
                        }}
                      />
                    </div>
                  )}
                  {/* Completed checkmark badge */}
                  {entry.completed && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 4,
                        right: 4,
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: "rgba(34,197,94,0.9)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#fff"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Text */}
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: focused ? "#e9d5ff" : "rgba(255,255,255,0.88)",
                      lineHeight: 1.3,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical" as const,
                    }}
                  >
                    {entry.title}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    {entry.completed ? (
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          color: "rgba(74,222,128,0.8)",
                          fontWeight: 600,
                        }}
                      >
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Completed
                      </span>
                    ) : (
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          color: "rgba(168,85,247,0.8)",
                          fontWeight: 600,
                        }}
                      >
                        <svg
                          width="8"
                          height="8"
                          viewBox="0 0 24 24"
                          fill="rgba(168,85,247,0.8)"
                        >
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        Resume {formatTime(entry.positionSecs)}
                        {entry.durationSecs > 0 && ` · ${pct}%`}
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 11,
                        color: "rgba(255,255,255,0.2)",
                      }}
                    >
                      ·
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "rgba(255,255,255,0.3)",
                        fontWeight: 500,
                      }}
                    >
                      {timeAgo(entry.watchedAt)}
                    </span>
                  </div>
                </div>

                {/* Play chevron — visible only when focused */}
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
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Footer hint bar ─────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "10px var(--tv-safe-h, 60px)",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          display: "flex",
          gap: 24,
          flexShrink: 0,
          background: "rgba(0,0,0,0.3)",
        }}
      >
        {(
          [
            { key: "↑↓", label: "Navigate" },
            { key: "ENTER", label: "Play" },
            ...(entries.length > 0
              ? [{ key: "C", label: "Clear all" }]
              : []),
            { key: "ESC", label: "Back" },
          ] as { key: string; label: string }[]
        ).map(({ key, label }) => (
          <div
            key={key}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <kbd
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 5,
                padding: "2px 7px",
                fontSize: 11,
                fontWeight: 700,
                color: "rgba(255,255,255,0.7)",
                fontFamily: "inherit",
                letterSpacing: "0.02em",
              }}
            >
              {key}
            </kbd>
            <span
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.3)",
                fontWeight: 500,
              }}
            >
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
