import { useCallback, useEffect, useRef, useState } from "react";
import { useGuide } from "../hooks/useGuide";
import { Clock } from "../components/Clock";

interface TVGuideProps {
  onBack: () => void;
  onPlay: (youtubeId: string, title: string) => void;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  const mins = String(m).padStart(2, "0");
  return `${hour}:${mins} ${ampm}`;
}

function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function BellIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "#f59e0b" : "none"} stroke={filled ? "#f59e0b" : "rgba(255,255,255,0.6)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      {filled && <circle cx="18" cy="6" r="4" fill="#ef4444" stroke="none"/>}
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="none">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  );
}

export function TVGuide({ onBack, onPlay }: TVGuideProps) {
  const { items, liveOverrideTitle, loading, error, toggleReminder, hasReminder, refresh } = useGuide();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [actionMode, setActionMode] = useState<"browse" | "action">("browse");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  const totalItems = items.length;

  useEffect(() => {
    if (cardRefs.current[focusedIndex]) {
      cardRefs.current[focusedIndex]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [focusedIndex]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (actionMode === "action") {
      if (e.key === "Escape" || e.key === "Backspace" || e.key === "ArrowLeft") {
        e.preventDefault();
        setActionMode("browse");
        setSelectedIndex(null);
        return;
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(totalItems - 1, i + 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const item = items[focusedIndex];
      if (item?.isCurrent && item.youtubeId) {
        onPlay(item.youtubeId, item.title);
      } else if (item && !item.isCurrent) {
        setSelectedIndex(focusedIndex);
        setActionMode("action");
      }
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      const item = items[focusedIndex];
      if (item && !item.isCurrent) {
        toggleReminder(item.id);
      }
    } else if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      onBack();
    }
  }, [actionMode, focusedIndex, items, totalItems, onBack, onPlay, toggleReminder]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const currentIdx = items.findIndex((i) => i.isCurrent);
  const reminderCount = items.filter((i) => hasReminder(i.id)).length;

  return (
    <div
      ref={containerRef}
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "radial-gradient(ellipse at top, #1a0a2e 0%, #0a0a0f 60%)",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 60px 16px",
        flexShrink: 0,
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <button
            onClick={onBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 10,
              padding: "8px 16px",
              color: "rgba(255,255,255,0.8)",
              fontSize: 14,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Home
          </button>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#6A0DAD" }} />
              <span style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>TV Guide</span>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", marginLeft: 4 }}>Temple TV</span>
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
              24/7 Broadcast Schedule
              {reminderCount > 0 && (
                <span style={{ marginLeft: 10, color: "#f59e0b", fontWeight: 600 }}>
                  · {reminderCount} reminder{reminderCount !== 1 ? "s" : ""} set
                </span>
              )}
            </div>
          </div>
        </div>
        <Clock />
      </div>

      {/* Live override banner */}
      {liveOverrideTitle && (
        <div style={{
          margin: "0 60px",
          marginTop: 16,
          padding: "12px 20px",
          background: "linear-gradient(135deg, rgba(239,68,68,0.2), rgba(220,38,38,0.1))",
          border: "1px solid rgba(239,68,68,0.35)",
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444", animation: "pulse 1.5s infinite" }} />
            <span style={{ color: "#ef4444", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em" }}>LIVE NOW</span>
          </div>
          <span style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{liveOverrideTitle}</span>
        </div>
      )}

      {/* Column headers */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "80px 1fr 130px 120px 100px",
        gap: 0,
        padding: "12px 60px 8px",
        flexShrink: 0,
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        {["#", "Program", "Time", "Duration", "Reminder"].map((h) => (
          <div key={h} style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {h}
          </div>
        ))}
      </div>

      {/* Guide items list */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "8px 60px 40px" }}>
        {loading && (
          <div style={{ paddingTop: 60, display: "flex", flexDirection: "column", gap: 12 }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton" style={{ height: 72, borderRadius: 12, opacity: 0.6 - i * 0.08 }} />
            ))}
          </div>
        )}

        {error && !loading && (
          <div style={{
            paddingTop: 60,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
          }}>
            <div style={{ fontSize: 48 }}>📡</div>
            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 16 }}>Unable to load schedule</div>
            <button
              onClick={refresh}
              style={{
                background: "rgba(106,13,173,0.4)",
                border: "1px solid rgba(106,13,173,0.6)",
                borderRadius: 10,
                padding: "10px 24px",
                color: "#fff",
                fontSize: 14,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Try Again
            </button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div style={{ paddingTop: 60, textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📺</div>
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 16 }}>No schedule available right now</div>
            <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 13, marginTop: 8 }}>
              Check back later or visit the broadcast dashboard
            </div>
          </div>
        )}

        {!loading && items.map((item, idx) => {
          const isFocused = focusedIndex === idx;
          const isCurrentProgram = item.isCurrent;
          const hasRem = hasReminder(item.id);
          const isUpcoming = !isCurrentProgram;
          const isSelected = selectedIndex === idx && actionMode === "action";

          return (
            <div
              key={item.id}
              ref={(el) => { cardRefs.current[idx] = el; }}
              onClick={() => {
                setFocusedIndex(idx);
                if (isCurrentProgram && item.youtubeId) {
                  onPlay(item.youtubeId, item.title);
                } else if (isUpcoming) {
                  toggleReminder(item.id);
                }
              }}
              style={{
                display: "grid",
                gridTemplateColumns: "80px 1fr 130px 120px 100px",
                gap: 0,
                alignItems: "center",
                padding: "14px 16px",
                marginBottom: 4,
                borderRadius: 14,
                cursor: "pointer",
                transition: "all 0.15s ease",
                background: isCurrentProgram
                  ? "linear-gradient(135deg, rgba(106,13,173,0.35) 0%, rgba(139,29,200,0.2) 100%)"
                  : isFocused
                  ? "rgba(255,255,255,0.07)"
                  : "rgba(255,255,255,0.02)",
                border: isCurrentProgram
                  ? "1px solid rgba(106,13,173,0.5)"
                  : isFocused
                  ? "1px solid rgba(255,255,255,0.18)"
                  : "1px solid rgba(255,255,255,0.04)",
                boxShadow: isFocused ? "0 0 0 2px rgba(106,13,173,0.3), 0 4px 20px rgba(0,0,0,0.3)" : "none",
                outline: "none",
              }}
            >
              {/* Index / Now badge */}
              <div style={{ display: "flex", alignItems: "center" }}>
                {isCurrentProgram ? (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    background: "rgba(106,13,173,0.6)",
                    borderRadius: 6,
                    padding: "4px 8px",
                  }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7" }} />
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#c084fc", letterSpacing: "0.06em" }}>NOW</span>
                  </div>
                ) : (
                  <span style={{ fontSize: 14, color: "rgba(255,255,255,0.25)", fontWeight: 500, paddingLeft: 8 }}>
                    {idx < currentIdx ? "—" : `+${idx - currentIdx}`}
                  </span>
                )}
              </div>

              {/* Title + thumbnail */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, paddingRight: 16, overflow: "hidden" }}>
                {item.thumbnailUrl ? (
                  <div style={{
                    width: 64,
                    height: 36,
                    borderRadius: 6,
                    overflow: "hidden",
                    flexShrink: 0,
                    border: "1px solid rgba(255,255,255,0.1)",
                    position: "relative",
                  }}>
                    <img
                      src={item.thumbnailUrl}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    {isCurrentProgram && (
                      <div style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(0,0,0,0.4)",
                      }}>
                        <PlayIcon />
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{
                    width: 64,
                    height: 36,
                    borderRadius: 6,
                    background: "rgba(106,13,173,0.3)",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="rgba(168,85,247,0.6)">
                      <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                    </svg>
                  </div>
                )}
                <div style={{ overflow: "hidden" }}>
                  <div style={{
                    fontSize: 14,
                    fontWeight: isCurrentProgram ? 700 : 500,
                    color: isCurrentProgram ? "#e9d5ff" : isFocused ? "#fff" : "rgba(255,255,255,0.8)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    lineHeight: 1.3,
                  }}>
                    {item.title}
                  </div>
                  {isCurrentProgram && (
                    <div style={{ marginTop: 4 }}>
                      <div style={{
                        width: "100%",
                        maxWidth: 200,
                        height: 3,
                        background: "rgba(168,85,247,0.25)",
                        borderRadius: 2,
                        overflow: "hidden",
                      }}>
                        <div style={{
                          height: "100%",
                          width: `${item.progressPercent}%`,
                          background: "linear-gradient(90deg, #7c3aed, #a855f7)",
                          borderRadius: 2,
                          transition: "width 1s linear",
                        }} />
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(168,85,247,0.8)", marginTop: 3 }}>
                        {Math.round(item.progressPercent)}% complete
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Start time */}
              <div style={{ fontSize: 14, color: isCurrentProgram ? "#c084fc" : "rgba(255,255,255,0.55)", fontWeight: 500 }}>
                {fmtTime(item.startMs)}
                {!isCurrentProgram && (
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>
                    ends {fmtTime(item.endMs)}
                  </div>
                )}
              </div>

              {/* Duration */}
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>
                {fmtDuration(item.durationSecs)}
              </div>

              {/* Reminder */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                {isCurrentProgram ? (
                  item.youtubeId ? (
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "rgba(106,13,173,0.5)",
                      borderRadius: 8,
                      padding: "4px 10px",
                      fontSize: 12,
                      color: "#c084fc",
                      fontWeight: 600,
                    }}>
                      <PlayIcon />
                      <span>Watch</span>
                    </div>
                  ) : null
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleReminder(item.id);
                    }}
                    style={{
                      background: hasRem ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.06)",
                      border: `1px solid ${hasRem ? "rgba(245,158,11,0.4)" : "rgba(255,255,255,0.1)"}`,
                      borderRadius: 8,
                      padding: "6px 10px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      transition: "all 0.15s",
                      fontFamily: "inherit",
                    }}
                    title={hasRem ? "Remove reminder" : "Set reminder"}
                  >
                    <BellIcon filled={hasRem} />
                    <span style={{ fontSize: 11, color: hasRem ? "#f59e0b" : "rgba(255,255,255,0.4)", fontWeight: 600 }}>
                      {hasRem ? "Set" : "Remind"}
                    </span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom hint bar */}
      <div style={{
        padding: "12px 60px",
        borderTop: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        gap: 24,
        flexShrink: 0,
      }}>
        {[
          { key: "↑ ↓", label: "Navigate" },
          { key: "ENTER", label: "Watch / Details" },
          { key: "R", label: "Toggle Reminder" },
          { key: "ESC", label: "Back to Home" },
        ].map((hint) => (
          <div key={hint.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <kbd style={{
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 11,
              color: "rgba(255,255,255,0.6)",
              fontFamily: "inherit",
            }}>
              {hint.key}
            </kbd>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>{hint.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
