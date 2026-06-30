import { useEffect, useRef, useState } from "react";
import type { LiveStatus, BroadcastCurrent } from "../lib/api";
import { isFireTV, isAndroidTV } from "../lib/platform";
import { LiveBroadcastV2 } from "./LiveBroadcastV2";
import { TempleTvLogo } from "./TempleTvLogo";
import { reportLiveFailure, useLiveFallbackJustTriggered } from "../lib/liveFailureSignal";
import { useLiveCountdown } from "../lib/liveCountdown";

interface LiveHeroProps {
  liveStatus: LiveStatus | null;
  broadcastCurrent?: BroadcastCurrent | null;
  focused: boolean;
  onSelect: () => void;
  viewerCount?: number | null;
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
export function LiveHero({ liveStatus, broadcastCurrent, focused, onSelect, viewerCount }: LiveHeroProps) {
  // Fire TV sticks and AndroidTV boxes have limited GPU memory and often run
  // on underpowered SoCs.  CSS backdrop-filter blur causes frame drops and
  // can stall the HLS pipeline on these platforms.  Disable ambient blur
  // entirely so the broadcast video gets full rendering budget.
  const enableAmbientBlur = !isFireTV && !isAndroidTV;

  const isLive = liveStatus?.isLive ?? false;
  // True when a YouTube broadcast is scheduled but not yet streaming.
  // Mutually exclusive with isLive (ytPoller guarantees this).
  const isUpcoming = !isLive && !!(liveStatus?.isUpcoming);
  const upcomingTitle = liveStatus?.upcomingTitle ?? null;
  const ytVideoId = liveStatus?.videoId;
  // One-shot banner: flashes for ~5 s when the live YouTube embed for this
  // device just dropped, so viewers understand why the cinematic preview
  // suddenly switched to the broadcast queue. Auto-clears.
  const showFallbackBanner = useLiveFallbackJustTriggered(ytVideoId);
  const ytThumbUrl = ytVideoId
    ? `https://img.youtube.com/vi/${ytVideoId}/maxresdefault.jpg`
    : null;

  const broadcastItem = broadcastCurrent?.item ?? null;
  // A scheduled live service is starting soon — surfaced in the off-air
  // hero copy so viewers know what's coming. The unified live SSE flips
  // `isLive` true the moment the stream goes hot, at which point this
  // branch evaluates false and the live "Now" copy takes over instantly.
  // Suppressed when isUpcoming is already true (YouTube signal is
  // more specific; both amber states would render identically).
  const showScheduledLive =
    !isLive && !isUpcoming && broadcastCurrent?.activeSchedule?.contentType === "live";
  // Real-time countdown to the scheduled start, server-time-aligned so a
  // misconfigured TV clock doesn't show a wrong number. Hidden when the
  // schedule is missing a startTime, in the past, or >24h away.
  const countdown = useLiveCountdown(
    showScheduledLive ? broadcastCurrent?.activeSchedule?.startTime : null,
    broadcastCurrent?.serverTimeMs ?? null,
  );

  const broadcastThumb = broadcastItem?.thumbnailUrl ?? null;
  const bgThumb = isLive ? ytThumbUrl : (broadcastThumb || null);

  // Fast-loading: the hero poster is the LCP candidate — its bytes block
  // the user's first painted impression of "Temple TV". Inject a
  // `<link rel="preload" as="image">` the moment we know the URL so the
  // browser starts the image fetch in parallel with React render rather
  // than waiting for the <img> tag to mount. Also `fetchpriority=high`
  // for browsers that honour it (Chromium/WebKit). Cleanup on unmount or
  // URL change so we don't leak <link> nodes when the broadcast advances.
  useEffect(() => {
    if (!bgThumb || typeof document === "undefined") return;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = bgThumb;
    // `fetchpriority` is a recent attribute; setAttribute keeps it
    // forward-compatible for older Smart-TV browsers that ignore it.
    link.setAttribute("fetchpriority", "high");
    document.head.appendChild(link);
    return () => {
      if (link.parentNode) link.parentNode.removeChild(link);
    };
  }, [bgThumb]);

  const [mounted, setMounted] = useState(false);
  // If the embedded live-broadcast surface fails (e.g. CDN unreachable, codec
  // unsupported), fall back to the blurred poster image so the hero is never
  // an empty black box. The fallback is reset whenever the item swaps so a
  // bad URL on item N doesn't prevent item N+1 from loading.
  const [broadcastVideoFailed, setBroadcastVideoFailed] = useState(false);
  const broadcastItemId = broadcastItem?.id ?? null;
  // The v2 player is fully self-contained: it connects directly to the
  // broadcast-v2 engine via WebSocket/SSE and handles ALL states internally —
  // queue playback, YouTube override, shuffle-fallback, FATAL recovery, and
  // the off-air "Temple TV is currently off-air" overlay.
  //
  // We no longer gate on `broadcastItem !== null` (hasBroadcast) because:
  //   1. When the broadcast engine is in override mode (e.g. YouTube shuffle
  //      fallback active after an empty queue), `broadcastItem` from the
  //      legacy /api/playback/state endpoint is null — even though the
  //      engine IS running and serving content. Gating on it caused the
  //      player to never mount, producing a permanent black hero.
  //   2. The v2 component owns its own "off-air" overlay for the truly-
  //      empty case, so a no-content guard here is redundant and harmful.
  //
  // Gate only on `!isLive` (no YouTube LIVE NOW active) and `!broadcastVideoFailed`
  // (kept for future onFatal wiring, currently always false since no onFatal
  // prop is passed to LiveBroadcastV2 in this hero context).
  const showLiveBroadcast = !isLive && !broadcastVideoFailed;

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
        height: "var(--hero-h)",
        minHeight: "var(--hero-min-h)",
        background: "#060606",
        cursor: "pointer",
        outline: "none",
      }}
      data-testid="live-hero"
    >
      {/* Broadcasting identity banner — top of hero, always visible */}
      <div
        aria-label="Jesus Christ Temple Ministry Broadcasting Now"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "clamp(10px, 1.4vh, 18px) var(--tv-safe-h, 60px)",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            fontSize: "clamp(11px, 1vw, 14px)",
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.82)",
            textShadow: "0 1px 8px rgba(0,0,0,0.7)",
          }}
        >
          ✝&nbsp; Jesus Christ Temple Ministry Broadcasting Now
        </span>
      </div>

      {/* Live-fallback flash banner — see useLiveFallbackJustTriggered. */}
      {showFallbackBanner && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            top: "var(--tv-safe-v, 24px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 50,
            background: "rgba(13, 17, 23, 0.92)",
            border: "1px solid rgba(255, 255, 255, 0.18)",
            color: "#FFF",
            padding: "10px 18px",
            borderRadius: 999,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "0.01em",
            display: "flex",
            alignItems: "center",
            gap: 10,
            backdropFilter: "blur(12px)",
            boxShadow: "0 6px 24px rgba(0, 0, 0, 0.45)",
            animation: "tv-fallback-fade-in 240ms ease-out",
          }}
          data-testid="live-fallback-banner"
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#FF8A00",
              boxShadow: "0 0 8px rgba(255, 138, 0, 0.7)",
            }}
          />
          Live unavailable — playing the broadcast queue instead
          <style>{`@keyframes tv-fallback-fade-in { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }`}</style>
        </div>
      )}

      {/* ── LAYER 1 (blur fill): Cinematic backdrop — covers the entire frame ── */}
      {/* This layer always covers 100% of the container so there are no empty edges,
          even when the actual video has a different aspect ratio. */}
      {ytVideoId && isLive ? (
        <LiveHeroPreviewIframe videoId={ytVideoId} />
      ) : showLiveBroadcast ? (
        <>
          {/* Poster fill — visible only until the live-broadcast layers fade in,
              so the hero never shows a black box during HLS handshake. */}
          {bgThumb && (
            // Eager-load + async-decode: this poster is the *only* thing
            // covering the frame during the HLS handshake, so we never
            // want lazy-load here (it would defeat the "no black box"
            // contract). decoding="async" still keeps decode off the
            // main thread.
            <img
              src={bgThumb}
              alt=""
              aria-hidden
              decoding="async"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
                filter: enableAmbientBlur
                  ? "blur(28px) saturate(1.4) brightness(0.55)"
                  : "brightness(0.4)",
                transform: "scale(1.08)",
              }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
          {/* Real ON AIR broadcast surface — joins the 24/7 timeline at the
              exact second the server says is currently airing, swaps items
              when the broadcast pipeline advances (via A/B preloaded slots
              for an instant cut, no spinner, no black frame), and re-syncs
              on drift. */}
          {/* v2 player owns its own transport, FSM, source resolution AND
              its own off-air / standby / fatal overlays. We no longer flip
              `broadcastVideoFailed` from here because the v2 component never
              throws an unrecoverable error up — it self-recovers, then shows
              its own "off air" surface if the queue truly has nothing to
              play. The legacy `setBroadcastVideoFailed` flag remains in the
              file for thumbnail-failure paths but is not driven by the
              broadcast pipeline anymore. */}
          {/* variant="hero" → object-cover fills the entire frame with no
              black bars. The video content is centre-cropped on non-16:9
              sources which is acceptable for a background preview banner. */}
          <LiveBroadcastV2 variant="hero" />
        </>
      ) : bgThumb ? (
        <>
          {/* Blurred background fill — LCP candidate, must NOT lazy-load. */}
          <img
            src={bgThumb}
            alt=""
            aria-hidden
            decoding="async"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              filter: enableAmbientBlur
                ? "blur(28px) saturate(1.3) brightness(0.5)"
                : "brightness(0.35)",
              transform: "scale(1.08)",
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          {/* Crisp foreground image — full aspect ratio, no cropping */}
          <img
            src={bgThumb}
            alt=""
            aria-hidden
            decoding="async"
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
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
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
            "0 clamp(20px, 4.5vw, 72px) calc(env(safe-area-inset-bottom, 0px) + clamp(18px, 3.5vw, 72px))",
          display: "flex",
          flexDirection: "column",
          gap: "clamp(8px, 1.2vw, 18px)",
          maxWidth: 1100,
          opacity: mounted ? 1 : 0,
          transform: mounted ? "translateY(0)" : "translateY(28px)",
          transition: "opacity 700ms ease 250ms, transform 700ms cubic-bezier(.18,.65,.18,1) 250ms",
        }}
      >
        {isLive ? (
          <>
            {/* ── State 1: YouTube Live ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
              <ViewerCountBadge count={viewerCount ?? null} />
            </div>
            <div
              className="flex items-center"
              style={{
                gap: "clamp(8px, 1.4vw, 12px)",
                marginTop: 4,
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
        ) : (
          <>
            {/* ── State 2 / 3: Broadcast active or off-air ──────────────────
                The badge adapts to three sub-states:
                  • broadcastCurrent?.item → "ON AIR · TEMPLE TV" (purple)
                  • showScheduledLive      → "STARTING SOON" countdown (amber)
                  • neither               → "OFF AIR · 24/7 ON DEMAND" (muted)
                LiveBroadcastV2 (background layer) owns its own off-air overlay;
                this metadata panel drives only the informational copy.
                Previous code had `isLive ? A : !isLive ? B : C` where the
                third branch (C) was unreachable — fixed by collapsing to a
                single !isLive branch with adaptive content. */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                className="flex items-center gap-2 rounded-full"
                style={{
                  background: isUpcoming || showScheduledLive
                    ? "rgba(255,138,0,0.18)"
                    : broadcastCurrent?.item
                    ? "rgba(106,13,173,0.85)"
                    : "rgba(255,255,255,0.14)",
                  width: "fit-content",
                  padding: "6px 16px",
                  backdropFilter: "blur(6px)",
                  border: isUpcoming || showScheduledLive
                    ? "1px solid rgba(255,138,0,0.45)"
                    : broadcastCurrent?.item
                    ? "1px solid rgba(168,85,247,0.4)"
                    : "1px solid rgba(255,255,255,0.12)",
                  boxShadow:
                    broadcastCurrent?.item && !showScheduledLive && !isUpcoming
                      ? "0 6px 24px rgba(106,13,173,0.45)"
                      : undefined,
                }}
              >
                <div
                  className={
                    broadcastCurrent?.item || showScheduledLive || isUpcoming
                      ? "live-pulse rounded-full"
                      : "rounded-full"
                  }
                  style={{
                    width: 8,
                    height: 8,
                    background: isUpcoming || showScheduledLive
                      ? "#FF8A00"
                      : broadcastCurrent?.item
                      ? "#a855f7"
                      : "rgba(255,255,255,0.5)",
                    boxShadow: isUpcoming || showScheduledLive
                      ? "0 0 10px rgba(255,138,0,0.7)"
                      : undefined,
                    animation: countdown?.imminent
                      ? "tv-imminent-pulse 900ms ease-in-out infinite"
                      : undefined,
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    color: isUpcoming || showScheduledLive ? "#FFD79A" : "#fff",
                    letterSpacing: "0.14em",
                  }}
                >
                  {isUpcoming
                    ? "UPCOMING BROADCAST"
                    : showScheduledLive
                    ? countdown
                      ? countdown.label.toUpperCase()
                      : "STARTING SOON"
                    : broadcastCurrent?.item
                    ? "ON AIR · TEMPLE TV"
                    : "OFF AIR · 24/7 ON DEMAND"}
                </span>
              </div>
              {(broadcastCurrent?.item || showScheduledLive || isUpcoming) && (
                <ViewerCountBadge count={viewerCount ?? null} />
              )}
            </div>

            {/* Logo + description — hidden on small phones (≤480px) via
                .tt-hero-expand to avoid obscuring the 16:9 video area */}
            <div className="tt-hero-expand">
              <TempleTvLogo size={60} variant="icon" decorative />
              <p
                style={{
                  fontSize: "clamp(14px, 1.3vw, 20px)",
                  color: "rgba(255,255,255,0.82)",
                  maxWidth: 680,
                  lineHeight: 1.5,
                  textShadow: "0 2px 16px rgba(0,0,0,0.55)",
                  margin: 0,
                }}
              >
                {isUpcoming
                  ? upcomingTitle
                    ? `Coming up: ${upcomingTitle}`
                    : "A live broadcast is starting soon — watch for the stream to begin."
                  : showScheduledLive
                  ? "Scheduled live service — tap to join when ready."
                  : "Spirit-filled teachings and worship — broadcasting live around the clock."}
              </p>
            </div>

            {/* CTA — only shown when NOT actively playing queue content.
                When broadcastCurrent.item exists the broadcast player is
                already running; clicking anywhere on the hero triggers
                onSelect() which opens the full-screen player — a "Watch
                Now" button here would be a redundant, confusing duplicate. */}
            {!broadcastCurrent?.item && (
              <div
                className="flex items-center rounded-xl"
                style={{
                  background: focused
                    ? isUpcoming || showScheduledLive ? "rgba(255,138,0,0.95)" : "hsl(270 75% 50%)"
                    : isUpcoming || showScheduledLive ? "rgba(255,138,0,0.75)" : "rgba(106,13,173,0.9)",
                  color: "#fff",
                  padding: "clamp(12px, 1.8vw, 16px) clamp(20px, 3.2vw, 32px)",
                  gap: "clamp(6px, 1vw, 10px)",
                  width: "fit-content",
                  marginTop: 4,
                  boxShadow: focused
                    ? "0 12px 36px rgba(106,13,173,0.5)"
                    : "0 6px 20px rgba(0,0,0,0.35)",
                  transform: focused ? "scale(1.04)" : "scale(1)",
                  transition: "all 0.18s ease",
                  minHeight: 44,
                  border: `1px solid ${
                    isUpcoming || showScheduledLive
                      ? "rgba(255,138,0,0.5)"
                      : "rgba(168,85,247,0.35)"
                  }`,
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
                  {showScheduledLive ? "Tune In" : isUpcoming ? "Browse Archive" : "Browse Archive"}
                </span>
              </div>
            )}
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
    if (!videoId) return;
    const watchdog = setTimeout(() => {
      if (!loadedRef.current) reportLiveFailure(videoId, "tv-hero");
    }, LIVE_HERO_LOAD_TIMEOUT_MS);
    return () => clearTimeout(watchdog);
  }, [videoId]);

  // Defence in depth: callers should never render this with an empty
  // videoId (the parent already gates on `ytLiveBroadcast && ytVideoId`),
  // but if it ever does, refuse to mount an iframe whose src would be the
  // bare `/embed/` path — that emits an "empty src" warning on every render
  // and the iframe shows YouTube's generic error page.
  if (!videoId) return null;

  return (
    <iframe
      key={videoId}
      src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&loop=1&playlist=${videoId}&rel=0&iv_load_policy=3&disablekb=1`}
      allow="autoplay; encrypted-media; picture-in-picture"
      frameBorder={0}
      onLoad={() => { loadedRef.current = true; }}
      onError={() => reportLiveFailure(videoId, "tv-hero")}
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

/**
 * Frosted-glass viewer count pill — sits inline next to the ON AIR / LIVE NOW
 * badge. Only renders when `count` is a positive number; hides itself while
 * the SSE connection is establishing (count === null) so there's never a
 * dangling "—" or "0 watching" in the hero.
 */
function ViewerCountBadge({ count }: { count: number | null }) {
  if (count === null || count < 1) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        background: "rgba(0, 0, 0, 0.42)",
        border: "1px solid rgba(255, 255, 255, 0.16)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        borderRadius: 999,
        padding: "5px 12px",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="rgba(255,255,255,0.75)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: "#fff",
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.01em",
        }}
      >
        {count.toLocaleString()}
      </span>
      <span
        style={{
          fontSize: 11,
          color: "rgba(255, 255, 255, 0.58)",
          fontWeight: 500,
        }}
      >
        watching
      </span>
    </div>
  );
}
