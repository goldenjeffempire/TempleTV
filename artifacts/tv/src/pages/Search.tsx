import { useCallback, useEffect, useRef, useState } from "react";
import { useSearch } from "../hooks/useSearch";
import { Clock } from "../components/Clock";
import type { VideoItem } from "../lib/api";

const KEYBOARD_ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L", "⌫"],
  ["Z", "X", "C", "V", "B", "N", "M", " ", "CLR", "✓"],
];

interface SearchProps {
  onBack: () => void;
  onPlay: (videoId: string, title: string) => void;
  onDetails: (video: VideoItem) => void;
}

function KeyboardKey({ char, focused, onPress }: { char: string; focused: boolean; onPress: () => void }) {
  return (
    <div
      onClick={onPress}
      tabIndex={0}
      style={{
        width: 52,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        fontSize: char === " " ? 10 : char === "CLR" ? 11 : 16,
        fontWeight: 600,
        cursor: "pointer",
        flexShrink: 0,
        transition: "all 0.1s ease",
        background: focused ? "rgba(106,13,173,0.7)" : "rgba(255,255,255,0.08)",
        border: `1px solid ${focused ? "rgba(168,85,247,0.8)" : "rgba(255,255,255,0.12)"}`,
        color: focused ? "#fff" : "rgba(255,255,255,0.7)",
        boxShadow: focused ? "0 0 0 2px rgba(106,13,173,0.4), 0 4px 12px rgba(0,0,0,0.4)" : "none",
        transform: focused ? "scale(1.1)" : "scale(1)",
        userSelect: "none",
      }}
    >
      {char === " " ? "SPACE" : char}
    </div>
  );
}

function ResultCard({ video, focused, onSelect }: { video: VideoItem; focused: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focused]);

  return (
    <div
      ref={ref}
      onClick={onSelect}
      style={{
        display: "flex",
        gap: 14,
        padding: "12px 16px",
        borderRadius: 12,
        cursor: "pointer",
        transition: "all 0.15s ease",
        background: focused ? "rgba(106,13,173,0.25)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${focused ? "rgba(168,85,247,0.5)" : "rgba(255,255,255,0.06)"}`,
        boxShadow: focused ? "0 0 0 2px rgba(106,13,173,0.25)" : "none",
        alignItems: "center",
      }}
    >
      <div style={{ width: 120, height: 68, borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
        <img
          src={video.thumbnailUrl}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={(e) => { (e.target as HTMLImageElement).src = ""; }}
        />
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: focused ? "#e9d5ff" : "#fff", lineHeight: 1.3, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {video.title}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>{video.channelName} · {video.duration}</div>
      </div>
      {focused && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(106,13,173,0.6)", borderRadius: 8, padding: "6px 12px", flexShrink: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>Play</span>
        </div>
      )}
    </div>
  );
}

export function Search({ onBack, onPlay, onDetails }: SearchProps) {
  const { query, results, loading, search, allVideos } = useSearch();
  const [focusArea, setFocusArea] = useState<"keyboard" | "results">("keyboard");
  const [kbRow, setKbRow] = useState(0);
  const [kbCol, setKbCol] = useState(0);
  const [resultIdx, setResultIdx] = useState(0);

  const displayResults = query.trim() ? results : allVideos.slice(0, 16);

  const handleKeyChar = useCallback((char: string) => {
    if (char === "⌫") {
      search(query.slice(0, -1));
    } else if (char === "CLR") {
      search("");
    } else if (char === "✓") {
      if (displayResults.length > 0) {
        setFocusArea("results");
        setResultIdx(0);
      }
    } else {
      search(query + char);
    }
  }, [query, search, displayResults]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const rowCount = KEYBOARD_ROWS.length;

      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        if (focusArea === "results") { setFocusArea("keyboard"); return; }
        onBack();
        return;
      }

      if (focusArea === "keyboard") {
        const rowLen = KEYBOARD_ROWS[kbRow]?.length ?? 10;
        if (e.key === "ArrowUp") { e.preventDefault(); setKbRow((r) => Math.max(0, r - 1)); }
        else if (e.key === "ArrowDown") {
          e.preventDefault();
          if (kbRow === rowCount - 1 && displayResults.length > 0) { setFocusArea("results"); setResultIdx(0); }
          else setKbRow((r) => Math.min(rowCount - 1, r + 1));
        }
        else if (e.key === "ArrowLeft") { e.preventDefault(); setKbCol((c) => Math.max(0, c - 1)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); setKbCol((c) => Math.min(rowLen - 1, c + 1)); }
        else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const char = KEYBOARD_ROWS[kbRow]?.[kbCol];
          if (char) handleKeyChar(char);
        }
        else if (e.key.length === 1 && /[a-zA-Z0-9 ]/.test(e.key)) {
          search(query + e.key.toUpperCase());
        }
        else if (e.key === "Backspace" && query.length > 0) {
          e.preventDefault();
          search(query.slice(0, -1));
        }
      } else {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (resultIdx === 0) { setFocusArea("keyboard"); }
          else setResultIdx((i) => Math.max(0, i - 1));
        }
        else if (e.key === "ArrowDown") { e.preventDefault(); setResultIdx((i) => Math.min(displayResults.length - 1, i + 1)); }
        else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const v = displayResults[resultIdx];
          if (v) onPlay(v.videoId, v.title);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusArea, kbRow, kbCol, query, displayResults, resultIdx, handleKeyChar, onBack, onPlay, search]);

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "radial-gradient(ellipse at top, #0d1a2e 0%, #0a0a0f 60%)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 60px 16px", flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <button
            onClick={onBack}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10, padding: "8px 16px", color: "rgba(255,255,255,0.8)", fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Home
          </button>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <span style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>Search</span>
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
              {loading ? "Loading library…" : `${allVideos.length} videos available`}
            </div>
          </div>
        </div>
        <Clock />
      </div>

      {/* Search input display */}
      <div style={{ padding: "16px 60px 12px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: "12px 20px" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <span style={{ fontSize: 20, color: query ? "#fff" : "rgba(255,255,255,0.3)", fontWeight: 500, flex: 1, letterSpacing: 1 }}>
            {query || "Start typing to search…"}
          </span>
          {query && (
            <span style={{ fontSize: 13, color: "rgba(168,85,247,0.8)", fontWeight: 600 }}>
              {displayResults.length} result{displayResults.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Main content: keyboard + results */}
      <div style={{ flex: 1, display: "flex", gap: 0, overflow: "hidden" }}>
        {/* On-screen keyboard */}
        <div style={{ width: 600, flexShrink: 0, padding: "8px 60px 16px 60px", display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" }}>
          {KEYBOARD_ROWS.map((row, rowIdx) => (
            <div key={rowIdx} style={{ display: "flex", gap: 6 }}>
              {row.map((char, colIdx) => (
                <KeyboardKey
                  key={char}
                  char={char}
                  focused={focusArea === "keyboard" && kbRow === rowIdx && kbCol === colIdx}
                  onPress={() => { setKbRow(rowIdx); setKbCol(colIdx); handleKeyChar(char); }}
                />
              ))}
            </div>
          ))}
          <div style={{ marginTop: 12, fontSize: 12, color: "rgba(255,255,255,0.25)", letterSpacing: "0.04em" }}>
            Arrow keys navigate · Enter selects · ESC back
          </div>
        </div>

        {/* Results panel */}
        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "8px 60px 40px 20px", borderLeft: "1px solid rgba(255,255,255,0.06)" }}>
          {displayResults.length === 0 && query.trim() ? (
            <div style={{ paddingTop: 60, textAlign: "center" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
              <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 16 }}>No results for "{query}"</div>
              <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 13, marginTop: 8 }}>Try different keywords</div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12, paddingLeft: 4 }}>
                {query.trim() ? "Search Results" : "All Videos"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {displayResults.map((video, idx) => (
                  <ResultCard
                    key={video.videoId}
                    video={video}
                    focused={focusArea === "results" && resultIdx === idx}
                    onSelect={() => { setFocusArea("results"); setResultIdx(idx); onPlay(video.videoId, video.title); }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Hint bar */}
      <div style={{ padding: "10px 60px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 20, flexShrink: 0 }}>
        {[{ key: "↑ ↓ ← →", label: "Navigate" }, { key: "ENTER", label: "Play" }, { key: "ESC", label: "Back" }].map(h => (
          <div key={h.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <kbd style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 5, padding: "2px 7px", fontSize: 11, color: "rgba(255,255,255,0.6)", fontFamily: "inherit" }}>{h.key}</kbd>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>{h.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
