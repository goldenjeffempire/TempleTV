import { useEffect, useRef, useState } from "react";
import { type LiveStatus, type BroadcastCurrent } from "../lib/api";

interface LiveHeroProps {
  liveStatus: LiveStatus | null;
  broadcastCurrent?: BroadcastCurrent | null;
  focused: boolean;
  onSelect: () => void;
}

function BroadcastProgressBar({
  progressPercent,
  positionSecs,
  totalSecs,
  serverTimeMs,
}: {
  progressPercent: number;
  positionSecs: number;
  totalSecs: number;
  serverTimeMs: number;
}) {
  const fetchedAt = useRef(Date.now());
  const fetchedServerMs = useRef(serverTimeMs);
  const [liveProgress, setLiveProgress] = useState(progressPercent);

  useEffect(() => {
    fetchedAt.current = Date.now();
    fetchedServerMs.current = serverTimeMs;
    setLiveProgress(progressPercent);
  }, [progressPercent, serverTimeMs, positionSecs]);

  useEffect(() => {
    if (totalSecs <= 0) return;
    const tick = setInterval(() => {
      const elapsed = (Date.now() - fetchedAt.current) / 1000;
      const current = positionSecs + elapsed;
      setLiveProgress(Math.min(100, (current / totalSecs) * 100));
    }, 2000);
    return () => clearInterval(tick);
  }, [positionSecs, totalSecs]);

  const remaining = Math.max(0, totalSecs - positionSecs);
  const remainMins = Math.floor(remaining / 60);
  const remainStr = remainMins > 0 ? `${remainMins}m left` : "Ending soon";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          height: 3,
          background: "rgba(255,255,255,0.2)",
          borderRadius: 2,
          overflow: "hidden",
          maxWidth: 420,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${liveProgress}%`,
            background: "linear-gradient(90deg, #6A0DAD, #a855f7)",
            borderRadius: 2,
            transition: "width 2s linear",
          }}
        />
      </div>
      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", letterSpacing: "0.04em" }}>
        {remainStr}
      </span>
    </div>
  );
}

/**
 * Netflix-style full-bleed cinematic hero.
 *
 * Three states:
 *  1. YouTube LIVE NOW — red badge, ambient YouTube embed, "Watch Live" CTA
 *  2. Broadcast ON AIR — purple "ON AIR" badge, thumbnail, progress bar, "Tune In" CTA
 *  3. Off-air — muted badge, gradient fallback, "Watch Temple TV" CTA
 */
export function LiveHero({ liveStatus, broadcastCurrent, focused, onSelect }: LiveHeroProps) {
  const isLive = liveStatus?.isLive ?? false;
  const ytVideoId = liveStatus?.videoId;
  const ytThumbUrl = ytVideoId
    ? `https://img.youtube.com/vi/${ytVideoId}/maxresdefault.jpg`
    : null;

  const broadcastItem = broadcastCurrent?.item ?? null;
  const hasBroadcast = !isLive && broadcastItem !== null;

  const broadcastThumb = broadcastItem?.thumbnailUrl ?? null;
  const bgThumb = isLive ? ytThumbUrl : (broadcastThumb || null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      tabIndex={0}
      onClick={onSelect}
      className={`relative overflow-hidden ${focused ? "tv-hero-focused" : ""}`}
      style={{
        width: "100%",
        height: "min(82vh, 820px)",
        minHeight: "max(60dvh, 360px)",
        background: "#070707",
        cursor: "pointer",
        outline: "none",
      }}
      data-testid="live-hero"
    >
      {/* Backdrop layer */}
      {focused && ytVideoId && isLive ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${ytVideoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&loop=1&playlist=${ytVideoId}&rel=0&iv_load_policy=3&disablekb=1`}
          allow="autoplay; encrypted-media; picture-in-picture"
          frameBorder={0}
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: "120%",
            height: "120%",
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            border: 0,
          }}
          title="Temple TV ambient preview"
        />
      ) : bgThumb ? (
        <img
          src={bgThumb}
          alt=""
          aria-hidden
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            transform: mounted ? "scale(1.04)" : "scale(1.12)",
            transition: "transform 1200ms cubic-bezier(.2,.6,.2,1)",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background:
              "radial-gradient(circle at 30% 30%, #2a0018 0%, #0a0a0a 60%), linear-gradient(135deg, #1a0010 0%, #2d0020 50%, #0a0a0a 100%)",
          }}
        />
      )}

      {/* Cinematic gradient stack */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(7,7,7,0.55) 0%, rgba(7,7,7,0) 22%, rgba(7,7,7,0) 50%, rgba(7,7,7,0.85) 88%, #070707 100%)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(7,7,7,0.92) 0%, rgba(7,7,7,0.55) 28%, rgba(7,7,7,0) 60%)",
        }}
      />

      {/* Focus ring */}
      {focused && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 12,
            borderRadius: 16,
            boxShadow: "0 0 0 3px rgba(255,255,255,0.85), 0 0 0 6px rgba(0,0,0,0.4)",
            pointerEvents: "none",
            transition: "box-shadow 0.2s ease",
          }}
        />
      )}

      {/* Metadata block — bottom-left */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding:
            "0 clamp(16px, 4vw, 60px) calc(env(safe-area-inset-bottom, 0px) + clamp(32px, 6vw, 80px))",
          display: "flex",
          flexDirection: "column",
          gap: "clamp(10px, 1.6vw, 18px)",
          maxWidth: 980,
          opacity: mounted ? 1 : 0,
          transform: mounted ? "translateY(0)" : "translateY(24px)",
          transition: "opacity 600ms ease 200ms, transform 600ms cubic-bezier(.2,.6,.2,1) 200ms",
        }}
      >
        {isLive ? (
          <>
            {/* ── State 1: YouTube Live ── */}
            <div
              className="flex items-center gap-2 rounded-full"
              style={{
                background: "hsl(0 78% 50%)",
                width: "fit-content",
                padding: "6px 16px",
                boxShadow: "0 6px 24px rgba(220,38,38,0.4)",
              }}
            >
              <div
                className="live-pulse rounded-full"
                style={{ width: 9, height: 9, background: "#fff" }}
              />
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: "#fff",
                  letterSpacing: "0.14em",
                }}
              >
                LIVE NOW
              </span>
            </div>
            <h1
              style={{
                fontSize: "clamp(40px, 5.2vw, 72px)",
                fontWeight: 900,
                color: "#fff",
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
                textShadow: "0 4px 32px rgba(0,0,0,0.6)",
                margin: 0,
              }}
            >
              {liveStatus?.title ?? "Temple TV Live Stream"}
            </h1>
            <p
              style={{
                fontSize: "clamp(16px, 1.4vw, 22px)",
                color: "rgba(255,255,255,0.82)",
                maxWidth: 720,
                lineHeight: 1.5,
                textShadow: "0 2px 16px rgba(0,0,0,0.55)",
                margin: 0,
              }}
            >
              Live worship & teachings from Jesus Christ Temple Ministry — streaming right now.
            </p>
            <div
              className="flex items-center"
              style={{
                gap: "clamp(8px, 1.4vw, 12px)",
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              <div
                className="flex items-center rounded-xl"
                style={{
                  background: focused ? "#fff" : "rgba(255,255,255,0.92)",
                  color: "#0a0a0a",
                  padding: "clamp(12px, 1.8vw, 16px) clamp(20px, 3.2vw, 32px)",
                  gap: "clamp(8px, 1.2vw, 12px)",
                  width: "fit-content",
                  boxShadow: focused
                    ? "0 12px 36px rgba(255,255,255,0.25)"
                    : "0 6px 20px rgba(0,0,0,0.4)",
                  transform: focused ? "scale(1.04)" : "scale(1)",
                  transition: "all 0.18s ease",
                  minHeight: 44,
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  style={{ width: "clamp(18px, 2vw, 22px)", height: "auto" }}
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span
                  style={{
                    fontSize: "clamp(15px, 1.8vw, 19px)",
                    fontWeight: 800,
                    letterSpacing: "-0.01em",
                  }}
                >
                  Watch Live
                </span>
              </div>
              <div
                className="flex items-center rounded-xl"
                style={{
                  background: "rgba(109,109,110,0.7)",
                  color: "#fff",
                  padding: "clamp(12px, 1.8vw, 16px) clamp(16px, 2.6vw, 26px)",
                  gap: "clamp(6px, 1vw, 8px)",
                  backdropFilter: "blur(6px)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  minHeight: 44,
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: "clamp(16px, 1.8vw, 18px)", height: "auto" }}
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span style={{ fontSize: "clamp(13px, 1.5vw, 16px)", fontWeight: 600 }}>
                  More info
                </span>
              </div>
            </div>
          </>
        ) : hasBroadcast ? (
          <>
            {/* ── State 2: 24/7 Broadcast On Air ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                className="flex items-center gap-2 rounded-full"
                style={{
                  background: "rgba(106,13,173,0.85)",
                  width: "fit-content",
                  padding: "6px 16px",
                  boxShadow: "0 6px 24px rgba(106,13,173,0.45)",
                  border: "1px solid rgba(168,85,247,0.4)",
                  backdropFilter: "blur(6px)",
                }}
              >
                <div
                  className="live-pulse rounded-full"
                  style={{ width: 8, height: 8, background: "#a855f7" }}
                />
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    color: "#fff",
                    letterSpacing: "0.14em",
                  }}
                >
                  ON AIR · TEMPLE TV
                </span>
              </div>
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.45)",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                }}
              >
                24/7 BROADCAST
              </span>
            </div>

            <h1
              style={{
                fontSize: "clamp(40px, 5.2vw, 72px)",
                fontWeight: 900,
                color: "#fff",
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
                textShadow: "0 4px 32px rgba(0,0,0,0.6)",
                margin: 0,
              }}
            >
              Temple TV
            </h1>
            <p
              style={{
                fontSize: "clamp(16px, 1.4vw, 22px)",
                color: "rgba(255,255,255,0.82)",
                maxWidth: 720,
                lineHeight: 1.5,
                textShadow: "0 2px 16px rgba(0,0,0,0.55)",
                margin: 0,
              }}
            >
              Spirit-filled teachings and worship — broadcasting live around the clock.
            </p>

            {broadcastCurrent && (
              <BroadcastProgressBar
                progressPercent={broadcastCurrent.progressPercent}
                positionSecs={broadcastCurrent.positionSecs}
                totalSecs={broadcastCurrent.totalSecs}
                serverTimeMs={broadcastCurrent.serverTimeMs}
              />
            )}

            <div
              className="flex items-center"
              style={{ gap: "clamp(8px, 1.4vw, 12px)", marginTop: 4, flexWrap: "wrap" }}
            >
              <div
                className="flex items-center rounded-xl"
                style={{
                  background: focused ? "hsl(270 75% 50%)" : "rgba(106,13,173,0.9)",
                  color: "#fff",
                  padding: "clamp(12px, 1.8vw, 16px) clamp(20px, 3.2vw, 32px)",
                  gap: "clamp(8px, 1.2vw, 12px)",
                  width: "fit-content",
                  boxShadow: focused
                    ? "0 12px 36px rgba(106,13,173,0.55)"
                    : "0 6px 20px rgba(0,0,0,0.4)",
                  transform: focused ? "scale(1.04)" : "scale(1)",
                  transition: "all 0.18s ease",
                  minHeight: 44,
                  border: "1px solid rgba(168,85,247,0.35)",
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  style={{ width: "clamp(18px, 2vw, 22px)", height: "auto" }}
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span
                  style={{
                    fontSize: "clamp(15px, 1.8vw, 19px)",
                    fontWeight: 800,
                    letterSpacing: "-0.01em",
                  }}
                >
                  Tune In
                </span>
              </div>
              {broadcastCurrent?.nextItem && (
                <div
                  className="flex items-center rounded-xl"
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.75)",
                    padding: "clamp(12px, 1.8vw, 16px) clamp(16px, 2.6vw, 26px)",
                    gap: "clamp(6px, 1vw, 8px)",
                    backdropFilter: "blur(6px)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    minHeight: 44,
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ width: "clamp(14px, 1.5vw, 16px)", height: "auto" }}
                  >
                    <polygon points="5 4 15 12 5 20 5 4" />
                    <line x1="19" y1="5" x2="19" y2="19" />
                  </svg>
                  <span style={{ fontSize: "clamp(12px, 1.3vw, 15px)", fontWeight: 600 }}>
                    Up Next
                  </span>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* ── State 3: Off-air ── */}
            <div
              className="flex items-center gap-2 rounded-full"
              style={{
                background: "rgba(255,255,255,0.14)",
                width: "fit-content",
                padding: "6px 16px",
                backdropFilter: "blur(6px)",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              <div
                className="rounded-full"
                style={{ width: 9, height: 9, background: "rgba(255,255,255,0.5)" }}
              />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "rgba(255,255,255,0.88)",
                  letterSpacing: "0.14em",
                }}
              >
                OFF AIR · 24/7 ON DEMAND
              </span>
            </div>
            <h1
              style={{
                fontSize: "clamp(40px, 5.2vw, 72px)",
                fontWeight: 900,
                color: "#fff",
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
                textShadow: "0 4px 32px rgba(0,0,0,0.6)",
                margin: 0,
              }}
            >
              Temple TV
            </h1>
            <p
              style={{
                fontSize: "clamp(16px, 1.4vw, 22px)",
                color: "rgba(255,255,255,0.82)",
                maxWidth: 720,
                lineHeight: 1.5,
                textShadow: "0 2px 16px rgba(0,0,0,0.55)",
                margin: 0,
              }}
            >
              Jesus Christ Temple Ministry — Spirit-filled broadcasts, worship, and teachings any time you need them.
            </p>
            <div
              className="flex items-center rounded-xl"
              style={{
                background: focused ? "hsl(0 78% 50%)" : "rgba(220,38,38,0.85)",
                color: "#fff",
                padding: "clamp(12px, 1.8vw, 16px) clamp(20px, 3.2vw, 32px)",
                gap: "clamp(6px, 1vw, 10px)",
                width: "fit-content",
                marginTop: 8,
                boxShadow: focused
                  ? "0 12px 36px rgba(220,38,38,0.5)"
                  : "0 6px 20px rgba(0,0,0,0.35)",
                transform: focused ? "scale(1.04)" : "scale(1)",
                transition: "all 0.18s ease",
                minHeight: 44,
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                style={{ width: "clamp(16px, 1.8vw, 20px)", height: "auto" }}
              >
                <path d="M8 5v14l11-7z" />
              </svg>
              <span
                style={{
                  fontSize: "clamp(14px, 1.7vw, 18px)",
                  fontWeight: 800,
                  letterSpacing: "-0.01em",
                }}
              >
                Watch Temple TV
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
