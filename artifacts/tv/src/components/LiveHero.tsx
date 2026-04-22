import { useEffect, useState } from "react";
import { type LiveStatus } from "../lib/api";

interface LiveHeroProps {
  liveStatus: LiveStatus | null;
  focused: boolean;
  onSelect: () => void;
}

/**
 * Netflix-style full-bleed cinematic hero.
 *
 * - Spans the full viewport width (no side gutters)
 * - Tall (min ~78vh) so it dominates the fold
 * - Layered gradients for legibility against the ambient video preview
 * - Animated entrance for the metadata block
 * - Ambient muted YouTube preview when focused; static thumbnail otherwise
 */
export function LiveHero({ liveStatus, focused, onSelect }: LiveHeroProps) {
  const isLive = liveStatus?.isLive ?? false;
  const videoId = liveStatus?.videoId;
  const thumbUrl = videoId
    ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
    : null;

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
        minHeight: 520,
        background: "#070707",
        cursor: "pointer",
        outline: "none",
      }}
      data-testid="live-hero"
    >
      {/* Backdrop layer — ambient video when focused, thumbnail otherwise */}
      {focused && videoId ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&loop=1&playlist=${videoId}&rel=0&iv_load_policy=3&disablekb=1`}
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
      ) : thumbUrl ? (
        <img
          src={thumbUrl}
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

      {/* Cinematic gradient stack — bottom fade for metadata, left fade for read */}
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

      {/* Metadata block — bottom-left, Netflix style */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "0 60px 80px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          maxWidth: 980,
          opacity: mounted ? 1 : 0,
          transform: mounted ? "translateY(0)" : "translateY(24px)",
          transition: "opacity 600ms ease 200ms, transform 600ms cubic-bezier(.2,.6,.2,1) 200ms",
        }}
      >
        {isLive ? (
          <>
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
            <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
              <div
                className="flex items-center gap-3 rounded-xl"
                style={{
                  background: focused ? "#fff" : "rgba(255,255,255,0.92)",
                  color: "#0a0a0a",
                  padding: "16px 32px",
                  width: "fit-content",
                  boxShadow: focused
                    ? "0 12px 36px rgba(255,255,255,0.25)"
                    : "0 6px 20px rgba(0,0,0,0.4)",
                  transform: focused ? "scale(1.04)" : "scale(1)",
                  transition: "all 0.18s ease",
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.01em" }}>
                  Watch Live
                </span>
              </div>
              <div
                className="flex items-center gap-2 rounded-xl"
                style={{
                  background: "rgba(109,109,110,0.7)",
                  color: "#fff",
                  padding: "16px 26px",
                  backdropFilter: "blur(6px)",
                  border: "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span style={{ fontSize: 16, fontWeight: 600 }}>More info</span>
              </div>
            </div>
          </>
        ) : (
          <>
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
              className="flex items-center gap-2 rounded-xl"
              style={{
                background: focused ? "hsl(0 78% 50%)" : "rgba(220,38,38,0.85)",
                color: "#fff",
                padding: "16px 32px",
                width: "fit-content",
                marginTop: 8,
                boxShadow: focused
                  ? "0 12px 36px rgba(220,38,38,0.5)"
                  : "0 6px 20px rgba(0,0,0,0.35)",
                transform: focused ? "scale(1.04)" : "scale(1)",
                transition: "all 0.18s ease",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.01em" }}>
                Browse sermons
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
