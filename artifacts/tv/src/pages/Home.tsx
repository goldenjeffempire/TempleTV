import { useCallback, useRef, useState } from "react";
import { LiveHero } from "../components/LiveHero";
import { SermonRow } from "../components/SermonRow";
import { Clock } from "../components/Clock";
import { Player } from "./Player";
import { useTVNav } from "../hooks/useTVNav";
import { useSermons, useLiveStatus } from "../hooks/useData";

const CATEGORIES = [
  "Faith",
  "Healing",
  "Deliverance",
  "Worship",
  "Teachings",
  "Special Programs",
];

export function Home() {
  const { byCategory, loading } = useSermons();
  const liveStatus = useLiveStatus();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [player, setPlayer] = useState<{ videoId: string; title: string } | null>(null);

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
          setPlayer({ videoId: liveStatus.videoId, title: liveStatus.title ?? "Live Stream" });
        }
        return;
      }
      const sermons = byCategory[row.key] ?? [];
      const sermon = sermons[itemIndex];
      if (sermon) {
        setPlayer({ videoId: sermon.videoId, title: sermon.title });
      }
    },
    [rows, byCategory, liveStatus],
  );

  const { focusRow, getFocusItem } = useTVNav({
    rowCount: rows.length,
    getRowItemCount,
    onSelect,
    enabled: !player,
  });

  if (player) {
    return <Player videoId={player.videoId} title={player.title} onBack={() => setPlayer(null)} />;
  }

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 60px",
          flexShrink: 0,
        }}
      >
        <div className="flex items-center gap-4">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{ width: 42, height: 42, background: "hsl(0 78% 50%)" }}
          >
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
        <Clock />
      </div>

      {/* Scrollable content */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", paddingBottom: 40 }}
      >
        {/* Live Hero */}
        <div style={{ marginBottom: 24 }}>
          <LiveHero
            liveStatus={liveStatus}
            focused={focusRow === 0}
            onSelect={() => {
              if (liveStatus?.isLive && liveStatus.videoId) {
                setPlayer({ videoId: liveStatus.videoId, title: liveStatus.title ?? "Live" });
              }
            }}
          />
        </div>

        {/* Sermon rows */}
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
            const sermons = byCategory[cat] ?? [];
            if (sermons.length === 0) return null;
            const rowIndex = catIndex + 1;
            return (
              <SermonRow
                key={cat}
                title={cat}
                sermons={sermons}
                focusedIndex={getFocusItem(rowIndex)}
                rowFocused={focusRow === rowIndex}
                onCardFocus={() => {}}
                onCardSelect={(sermon) =>
                  setPlayer({ videoId: sermon.videoId, title: sermon.title })
                }
              />
            );
          })
        )}

        {/* Nav hint */}
        <div style={{ paddingLeft: 60, paddingTop: 16 }}>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>
            ↑ ↓ Navigate rows &nbsp; · &nbsp; ← → Select video &nbsp; · &nbsp; ENTER Play
          </p>
        </div>
      </div>
    </div>
  );
}
