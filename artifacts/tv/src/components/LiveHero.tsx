import { type LiveStatus } from "../lib/api";

interface LiveHeroProps {
  liveStatus: LiveStatus | null;
  focused: boolean;
  onSelect: () => void;
}

export function LiveHero({ liveStatus, focused, onSelect }: LiveHeroProps) {
  const isLive = liveStatus?.isLive ?? false;
  const videoId = liveStatus?.videoId;
  const thumbUrl = videoId
    ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
    : null;

  return (
    <div
      tabIndex={0}
      className={`tv-card relative overflow-hidden ${focused ? "tv-focused-primary" : ""}`}
      style={{
        height: 380,
        marginLeft: 60,
        marginRight: 60,
        marginBottom: 36,
        borderRadius: 20,
        background: "#111",
        cursor: "pointer",
      }}
      onClick={onSelect}
      onFocus={() => {}}
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt="Live"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "linear-gradient(135deg, #1a0010 0%, #2d0020 50%, #0a0a0a 100%)",
          }}
        />
      )}

      <div className="gradient-bottom absolute inset-0" />
      <div className="gradient-left absolute inset-0" />

      <div className="absolute inset-0 flex flex-col justify-end" style={{ padding: "36px 48px" }}>
        {isLive ? (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="flex items-center gap-2 rounded-full px-4 py-1.5" style={{ background: "hsl(0 78% 50%)", width: "fit-content" }}>
                <div className="live-pulse rounded-full" style={{ width: 8, height: 8, background: "#fff" }} />
                <span style={{ fontSize: 13, fontWeight: 800, color: "#fff", letterSpacing: "0.12em" }}>LIVE NOW</span>
              </div>
            </div>
            <h1 style={{ fontSize: 42, fontWeight: 800, color: "#fff", lineHeight: 1.2, maxWidth: 700 }}>
              {liveStatus?.title ?? "Temple TV Live Stream"}
            </h1>
            <p style={{ fontSize: 18, color: "rgba(255,255,255,0.7)", marginTop: 10 }}>
              Watch Temple TV JCTM live right now
            </p>
            {focused && (
              <div className="flex items-center gap-3 mt-6">
                <div
                  className="flex items-center gap-2 rounded-xl px-6 py-3"
                  style={{ background: "hsl(0 78% 50%)", width: "fit-content" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>Watch Live</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-full px-4 py-1.5 mb-4" style={{ background: "rgba(255,255,255,0.15)", width: "fit-content" }}>
              <div className="rounded-full" style={{ width: 8, height: 8, background: "rgba(255,255,255,0.6)" }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.85)", letterSpacing: "0.1em" }}>OFF AIR</span>
            </div>
            <h1 style={{ fontSize: 42, fontWeight: 800, color: "#fff", lineHeight: 1.2, maxWidth: 700 }}>
              Temple TV JCTM
            </h1>
            <p style={{ fontSize: 18, color: "rgba(255,255,255,0.65)", marginTop: 10 }}>
              Jesus Christ Temple Ministry — Broadcasts & Teachings
            </p>
          </>
        )}
      </div>
    </div>
  );
}
