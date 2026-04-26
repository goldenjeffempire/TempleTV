import { useEffect, useRef, useState } from "react";
import { type LiveStatus, type BroadcastCurrent } from "../lib/api";
import { LiveBroadcastVideo } from "./LiveBroadcastVideo";
import { BROADCAST_HERO_TITLE } from "../lib/broadcastIdentity";
import { reportLiveFailure } from "../lib/liveFailureSignal";

interface LiveHeroProps {
  liveStatus: LiveStatus | null;
  broadcastCurrent?: BroadcastCurrent | null;
  focused: boolean;
  onSelect: () => void;
}

// NOTE: The previous `BroadcastProgressBar` sub-component (a 2-second-tick
// progress bar + "Xm left" countdown) was removed in the Round 6 broadcast
// refinement. A real television channel does not show viewers how far through
// the current program they are or how much time is left — viewers join
// mid-show and the channel keeps moving. The hero keeps the channel bug,
// "ON AIR" badge, title, and Tune In CTA; that is the entire liveness
// surface now. The deleted sub-component used a `useRef` for "fetched-at"
// time-keeping that has no other consumer here, so only `useRef` was
// dropped from the React imports. `useEffect` and `useState` are still
// used by `LiveHero` itself (mounted-flag transitions and the
// `broadcastVideoFailed` fallback).

/**
 * Netflix-style full-bleed cinematic hero.
 *
 * Rendering strategy — two-layer video system:
 *  • Bottom (blur layer): thumbnail/video at objectFit "cover" + heavy blur + dark scrim
 *    → fills the entire frame for cinematic ambiance with no empty edges
 *  • Top (content layer): the actual video at objectFit "contain" (centered, letterboxed)
 *    → guarantees 100% of the original frame is always visible, never cropped
 *
 * Three states:
 *  1. YouTube LIVE NOW — red badge, ambient YouTube embed, "Watch Live" CTA
 *  2. Broadcast ON AIR — purple "ON AIR" badge, contain-scaled video, "Tune In" CTA
 *     (no progress bar — TV-channel behavior)
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
  // If the embedded live-broadcast surface fails (e.g. CDN unreachable, codec
  // unsupported), fall back to the blurred poster image so the hero is never
  // an empty black box. The fallback is reset whenever the item swaps so a
  // bad URL on item N doesn't prevent item N+1 from loading.
  const [broadcastVideoFailed, setBroadcastVideoFailed] = useState(false);
  const broadcastItemId = broadcastItem?.id ?? null;
  const showLiveBroadcast = hasBroadcast && !broadcastVideoFailed && !!broadcastItem?.localVideoUrl;

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    setBroadcastVideoFailed(false);
  }, [broadcastItemId]);

  return (
    <div
      tabIndex={0}
      onClick={onSelect}
      className={`relative overflow-hidden ${focused ? "tv-hero-focused" : ""}`}
      style={{
        width: "100%",
        height: "min(94vh, 1080px)",
        minHeight: "max(72dvh, 480px)",
        background: "#060606",
        cursor: "pointer",
        outline: "none",
      }}
      data-testid="live-hero"
    >
      {/* ── LAYER 1 (blur fill): Cinematic backdrop — covers the entire frame ── */}
      {/* This layer always covers 100% of the container so there are no empty edges,
          even when the actual video has a different aspect ratio. */}
      {focused && ytVideoId && isLive ? (
        <LiveHeroPreviewIframe videoId={ytVideoId} />
      ) : showLiveBroadcast ? (
        <>
          {/* Poster fill — visible only until the live-broadcast layers fade in,
              so the hero never shows a black box during HLS handshake. */}
          {bgThumb && (
            <img
              src={bgThumb}
              alt=""
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
                filter: "blur(28px) saturate(1.4) brightness(0.55)",
                transform: "scale(1.08)",
              }}
            />
          )}
          {/* Real ON AIR broadcast surface — joins the 24/7 timeline at the
              exact second the server says is currently airing, swaps items
              when the broadcast pipeline advances (via A/B preloaded slots
              for an instant cut, no spinner, no black frame), and re-syncs
              on drift. */}
          <LiveBroadcastVideo
            item={broadcastItem}
            positionSecs={broadcastCurrent?.positionSecs ?? 0}
            serverTimeMs={broadcastCurrent?.serverTimeMs ?? Date.now()}
            nextItem={broadcastCurrent?.nextItem ?? null}
            onError={() => setBroadcastVideoFailed(true)}
          />
        </>
      ) : bgThumb ? (
        <>
          {/* Blurred background fill */}
          <img
            src={bgThumb}
            alt=""
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              filter: "blur(28px) saturate(1.3) brightness(0.5)",
              transform: "scale(1.08)",
            }}
          />
          {/* Crisp foreground image — full aspect ratio, no cropping */}
          <img
            src={bgThumb}
            alt=""
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
              transform: mounted ? "scale(1.0)" : "scale(1.04)",
              transition: "transform 1800ms cubic-bezier(.2,.6,.2,1)",
            }}
          />
        </>
      ) : (
        /* Branded off-air gradient */
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at 35% 40%, #200028 0%, #0a000f 45%, #060606 100%)",
          }}
        />
      )}

      {/* ── Cinematic gradient stack ─────────────────────────────────────────── */}
      {/* Top scrim — header + focus-ring legibility */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(6,6,6,0.72) 0%, rgba(6,6,6,0.18) 16%, rgba(6,6,6,0) 32%)",
          pointerEvents: "none",
        }}
      />
      {/* Bottom content panel gradient */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, transparent 38%, rgba(6,6,6,0.55) 62%, rgba(6,6,6,0.92) 82%, #060606 100%)",
          pointerEvents: "none",
        }}
      />
      {/* Left editorial vignette — lets copy float over video */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(6,6,6,0.88) 0%, rgba(6,6,6,0.48) 22%, rgba(6,6,6,0.08) 48%, transparent 66%)",
          pointerEvents: "none",
        }}
      />
      {/* Right edge fade */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(270deg, rgba(6,6,6,0.45) 0%, transparent 28%)",
          pointerEvents: "none",
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

      {/* Channel bug — top-right TV network watermark */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: "clamp(14px, 2vh, 28px)",
          right: "clamp(16px, 2.5vw, 40px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 4,
          opacity: mounted ? 0.5 : 0,
          transition: "opacity 800ms ease 400ms",
          pointerEvents: "none",
        }}
      >
        <span style={{ fontSize: "clamp(8px, 0.8vw, 11px)", fontWeight: 800, letterSpacing: "0.22em", color: "rgba(255,255,255,0.9)" }}>
          TEMPLE TV
        </span>
        <span style={{ fontSize: "clamp(7px, 0.65vw, 9px)", fontWeight: 600, letterSpacing: "0.14em", color: "rgba(255,255,255,0.55)" }}>
          JCTM BROADCASTING
        </span>
      </div>

      {/* Metadata block — bottom-left */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding:
            "0 clamp(20px, 4.5vw, 72px) calc(env(safe-area-inset-bottom, 0px) + clamp(36px, 6.5vw, 96px))",
          display: "flex",
          flexDirection: "column",
          gap: "clamp(12px, 1.8vw, 22px)",
          maxWidth: 1100,
          opacity: mounted ? 1 : 0,
          transform: mounted ? "translateY(0)" : "translateY(28px)",
          transition: "opacity 700ms ease 250ms, transform 700ms cubic-bezier(.18,.65,.18,1) 250ms",
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
              {/* Round 8: hardcoded to a generic broadcaster heading.
                  Per the broadcast-clean directive, the live program's
                  title is never surfaced — the hero reads as a real TV
                  channel identity, not as a sermon-specific landing.
                  Round 9c: sourced from the shared identity module so
                  TV + mobile heros stay in lock-step. */}
              {BROADCAST_HERO_TITLE}
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

            {/* Round 6: removed BroadcastProgressBar — TV-channel viewers do
                not see playback position or remaining time. The "ON AIR"
                badge above is the only liveness indicator. */}

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
                background: focused ? "hsl(270 75% 50%)" : "rgba(106,13,173,0.9)",
                color: "#fff",
                padding: "clamp(12px, 1.8vw, 16px) clamp(20px, 3.2vw, 32px)",
                gap: "clamp(6px, 1vw, 10px)",
                width: "fit-content",
                marginTop: 8,
                boxShadow: focused
                  ? "0 12px 36px rgba(106,13,173,0.5)"
                  : "0 6px 20px rgba(0,0,0,0.35)",
                transform: focused ? "scale(1.04)" : "scale(1)",
                transition: "all 0.18s ease",
                minHeight: 44,
                border: "1px solid rgba(168,85,247,0.35)",
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

/**
 * Wraps the YouTube live preview iframe with failure detection.
 *
 * The native iframe `error` event is unreliable for cross-origin embeds —
 * a YouTube embed that's geo-blocked, age-restricted, or has embedding
 * disabled often loads as a 200 with an error page rather than firing
 * `onerror`. We therefore use a load watchdog (LIVE_HERO_LOAD_TIMEOUT_MS):
 * if the iframe hasn't fired `onload` within the window, we treat that
 * as a failure and report it via `reportLiveFailure`. The next render
 * pass through `useUnifiedLive` flips `isLive=false` so this hero falls
 * through to the broadcast queue, AND the full-screen player (which
 * subscribes to the same signal) drops to its broadcast fallback too.
 */
const LIVE_HERO_LOAD_TIMEOUT_MS = 12_000;

function LiveHeroPreviewIframe({ videoId }: { videoId: string }) {
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    const watchdog = setTimeout(() => {
      if (!loadedRef.current) reportLiveFailure(videoId);
    }, LIVE_HERO_LOAD_TIMEOUT_MS);
    return () => clearTimeout(watchdog);
  }, [videoId]);

  return (
    <iframe
      key={videoId}
      src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&loop=1&playlist=${videoId}&rel=0&iv_load_policy=3&disablekb=1`}
      allow="autoplay; encrypted-media; picture-in-picture"
      frameBorder={0}
      onLoad={() => { loadedRef.current = true; }}
      onError={() => reportLiveFailure(videoId)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        border: 0,
      }}
      title="Temple TV ambient preview"
    />
  );
}
