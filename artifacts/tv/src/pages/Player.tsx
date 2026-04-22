import { useEffect, useRef, useState } from "react";
import { keyEventToAction } from "../lib/tvKeys";
import { HlsVideoPlayer } from "../components/HlsVideoPlayer";

interface PlayerProps {
  videoId: string;
  title: string;
  onBack: () => void;
  /** When set, an HLS .m3u8 stream is played instead of the YouTube iframe. */
  hlsUrl?: string;
  /** Resume the HLS stream at this second offset (synced 24/7 broadcast). */
  startPositionSecs?: number;
}

const LOAD_TIMEOUT_MS = 8_000;
const MAX_AUTO_RETRIES = 3;
const RETRY_BACKOFF_MS = [400, 1500, 4000];

// Time (ms) until the control overlay auto-hides during playback.
const CONTROLS_HIDE_DELAY = 5_000;
// How many seconds to skip per FF / Rewind key press.
const SEEK_STEP_SECS = 15;

/** Send a command to the YouTube IFrame Player API via postMessage. */
function ytCommand(
  iframe: HTMLIFrameElement | null,
  func: string,
  args: unknown[] = [],
) {
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage(
    JSON.stringify({ event: "command", func, args }),
    "*",
  );
}

/**
 * Public router component.
 * Selects the HLS player for uploaded content or the YouTube iframe for YouTube IDs.
 */
export function Player({ videoId, title, onBack, hlsUrl, startPositionSecs = 0 }: PlayerProps) {
  if (hlsUrl) {
    return (
      <HlsVideoPlayer
        hlsUrl={hlsUrl}
        title={title}
        onBack={onBack}
        startPositionSecs={startPositionSecs}
      />
    );
  }
  return <YouTubePlayer videoId={videoId} title={title} onBack={onBack} />;
}

/** Internal YouTube-iframe player (only rendered when no hlsUrl is provided). */
function YouTubePlayer({ videoId, title, onBack }: { videoId: string; title: string; onBack: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [showControls, setShowControls] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [autoRetries, setAutoRetries] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);

  // Play / Pause state mirrored locally so we can show the right icon.
  // YouTube autoplay=1 → starts playing.
  const [isPlaying, setIsPlaying] = useState(true);
  // OSD seek nudge label ("+15s" / "−15s") that fades out quickly.
  const [seekOsd, setSeekOsd] = useState<string | null>(null);
  // Estimated current playback time in seconds (incremented locally every second).
  const currentSecs = useRef(0);

  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRemountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playTickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekOsdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Playback tick — increment estimated current time while playing ────────
  useEffect(() => {
    if (playTickTimer.current) clearInterval(playTickTimer.current);
    if (isPlaying && isLoaded) {
      playTickTimer.current = setInterval(() => {
        currentSecs.current += 1;
      }, 1_000);
    }
    return () => {
      if (playTickTimer.current) clearInterval(playTickTimer.current);
    };
  }, [isPlaying, isLoaded]);

  // ── Reset current time on new video ──────────────────────────────────────
  useEffect(() => {
    currentSecs.current = 0;
    setIsPlaying(true);
  }, [videoId]);

  // ── Show / hide controls overlay ─────────────────────────────────────────
  const resetHideTimer = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowControls(true);
    hideTimer.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY);
  };

  // ── Watchdog: auto-retry if iframe never reports load ────────────────────
  useEffect(() => {
    setIsLoaded(false);
    setLoadError(null);
    if (loadTimer.current) clearTimeout(loadTimer.current);
    if (retryRemountTimer.current) clearTimeout(retryRemountTimer.current);

    loadTimer.current = setTimeout(() => {
      if (!isLoaded) {
        if (autoRetries < MAX_AUTO_RETRIES) {
          const delay = RETRY_BACKOFF_MS[autoRetries] ?? 4_000;
          setAutoRetries((n) => n + 1);
          retryRemountTimer.current = setTimeout(
            () => setRetryKey((k) => k + 1),
            delay,
          );
        } else {
          setLoadError("We couldn't start playback. Please check the connection and try again.");
        }
      }
    }, LOAD_TIMEOUT_MS);

    return () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
      if (retryRemountTimer.current) clearTimeout(retryRemountTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey, videoId]);

  // ── Auto-recover on network restoration ──────────────────────────────────
  useEffect(() => {
    const onOnline = () => {
      if (loadError) {
        setAutoRetries(0);
        setLoadError(null);
        setRetryKey((k) => k + 1);
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [loadError]);

  // ── Listen for YouTube IFrame API state-change events ────────────────────
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        if (data?.event === "onStateChange") {
          // 1 = playing, 2 = paused, 0 = ended, 3 = buffering, 5 = cued
          if (data.info === 1) setIsPlaying(true);
          else if (data.info === 2 || data.info === 0) setIsPlaying(false);
        }
      } catch {
        // Non-JSON messages from other origins — safely ignore.
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // ── Keyboard / remote control handler ────────────────────────────────────
  useEffect(() => {
    resetHideTimer();

    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);
      if (!action) {
        resetHideTimer();
        return;
      }

      // Error state: only allow retry (select) or back.
      if (loadError) {
        if (action === "select") {
          e.preventDefault();
          setAutoRetries(0);
          setLoadError(null);
          setRetryKey((k) => k + 1);
        } else if (action === "back" || action === "exit") {
          e.preventDefault();
          onBack();
        }
        return;
      }

      switch (action) {
        case "back":
        case "exit":
          e.preventDefault();
          onBack();
          break;

        case "playpause":
          e.preventDefault();
          if (isPlaying) {
            ytCommand(iframeRef.current, "pauseVideo");
            setIsPlaying(false);
          } else {
            ytCommand(iframeRef.current, "playVideo");
            setIsPlaying(true);
          }
          resetHideTimer();
          break;

        case "play":
          e.preventDefault();
          ytCommand(iframeRef.current, "playVideo");
          setIsPlaying(true);
          resetHideTimer();
          break;

        case "pause":
        case "stop":
          e.preventDefault();
          ytCommand(iframeRef.current, "pauseVideo");
          setIsPlaying(false);
          resetHideTimer();
          break;

        case "fastforward": {
          e.preventDefault();
          const target = currentSecs.current + SEEK_STEP_SECS;
          ytCommand(iframeRef.current, "seekTo", [target, true]);
          currentSecs.current = target;
          showSeekOsd(`+${SEEK_STEP_SECS}s`);
          resetHideTimer();
          break;
        }

        case "rewind": {
          e.preventDefault();
          const target = Math.max(0, currentSecs.current - SEEK_STEP_SECS);
          ytCommand(iframeRef.current, "seekTo", [target, true]);
          currentSecs.current = target;
          showSeekOsd(`−${SEEK_STEP_SECS}s`);
          resetHideTimer();
          break;
        }

        // Left arrow: show controls if hidden, otherwise go back.
        case "left":
          if (!showControls) {
            e.preventDefault();
            resetHideTimer();
          }
          break;

        default:
          resetHideTimer();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBack, showControls, loadError, isPlaying]);

  const showSeekOsd = (label: string) => {
    setSeekOsd(label);
    if (seekOsdTimer.current) clearTimeout(seekOsdTimer.current);
    seekOsdTimer.current = setTimeout(() => setSeekOsd(null), 1_200);
  };

  const handleManualRetry = () => {
    setAutoRetries(0);
    setLoadError(null);
    setRetryKey((k) => k + 1);
  };

  const embedOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://templetv.org.ng";

  const embedParams = new URLSearchParams({
    autoplay: "1",
    controls: "0",
    rel: "0",
    modestbranding: "1",
    iv_load_policy: "3",
    cc_load_policy: "0",
    playsinline: "1",
    enablejsapi: "1",
    origin: embedOrigin,
  });
  const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?${embedParams.toString()}`;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100vw",
        height: "100dvh",
      }}
    >
      {/* Loading veil */}
      {!loadError && !isLoaded && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            background: "radial-gradient(circle at 50% 40%, #1a0010 0%, #050505 70%)",
            zIndex: 5,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              border: "3px solid rgba(255,255,255,0.12)",
              borderTopColor: "hsl(0 78% 55%)",
              animation: "tt-spin 0.9s linear infinite",
            }}
          />
          <p style={{ fontSize: 14, letterSpacing: "0.18em", fontWeight: 700, color: "rgba(255,255,255,0.55)", textTransform: "uppercase" }}>
            {autoRetries > 0 ? "Reconnecting…" : "Preparing playback"}
          </p>
        </div>
      )}

      {/* YouTube embed */}
      {!loadError && (
        <iframe
          key={retryKey}
          ref={iframeRef}
          src={embedUrl}
          title={title}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => {
            setIsLoaded(true);
            if (loadTimer.current) clearTimeout(loadTimer.current);
          }}
          onError={() => {
            if (autoRetries < MAX_AUTO_RETRIES) {
              setAutoRetries((n) => n + 1);
              setRetryKey((k) => k + 1);
            } else {
              setLoadError("Playback failed to start. Please try again.");
            }
          }}
          style={{ width: "100%", height: "100%", border: "none", display: "block", touchAction: "manipulation" }}
        />
      )}

      {/* Error state */}
      {loadError && (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "clamp(14px, 2.5vw, 24px)",
            padding: "0 clamp(20px, 6vw, 60px)",
            textAlign: "center",
            width: "100%",
            maxWidth: 720,
          }}
        >
          <div aria-hidden style={{ width: "clamp(48px, 8vw, 64px)", height: "clamp(48px, 8vw, 64px)", borderRadius: "50%", background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "clamp(22px, 4vw, 30px)" }}>
            ⚠️
          </div>
          <h2 style={{ fontSize: "clamp(20px, 4.2vw, 32px)", fontWeight: 700, color: "#fff", margin: 0, lineHeight: 1.2 }}>
            Playback unavailable
          </h2>
          <p style={{ fontSize: "clamp(14px, 2.2vw, 18px)", color: "rgba(255,255,255,0.7)", maxWidth: 560, lineHeight: 1.5, margin: 0 }}>
            {loadError}
          </p>
          <div style={{ display: "flex", gap: "clamp(10px, 2vw, 16px)", flexWrap: "wrap", justifyContent: "center" }}>
            <button
              autoFocus
              onClick={handleManualRetry}
              style={{ background: "hsl(0 78% 50%)", color: "#fff", border: "none", borderRadius: 12, padding: "clamp(12px, 2vw, 14px) clamp(22px, 4vw, 32px)", fontSize: "clamp(15px, 2.2vw, 18px)", fontWeight: 700, cursor: "pointer", outline: "none", minHeight: 44 }}
            >
              Try again
            </button>
            <button
              onClick={onBack}
              style={{ background: "rgba(255,255,255,0.12)", color: "#fff", border: "none", borderRadius: 12, padding: "clamp(12px, 2vw, 14px) clamp(22px, 4vw, 32px)", fontSize: "clamp(15px, 2.2vw, 18px)", fontWeight: 600, cursor: "pointer", minHeight: 44 }}
            >
              Back
            </button>
          </div>
          <p className="tt-hide-on-touch" style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", marginTop: 8 }}>
            Press <strong style={{ color: "#fff" }}>ENTER</strong> to retry,{" "}
            <strong style={{ color: "#fff" }}>BACK</strong> to return
          </p>
        </div>
      )}

      {/* Seek OSD — "+15s" / "−15s" flash in the center */}
      {seekOsd && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 20,
          }}
        >
          <div
            style={{
              background: "rgba(0,0,0,0.72)",
              backdropFilter: "blur(8px)",
              borderRadius: 16,
              padding: "18px 36px",
              fontSize: "clamp(28px, 4vw, 48px)",
              fontWeight: 800,
              color: "#fff",
              letterSpacing: "0.02em",
            }}
          >
            {seekOsd}
          </div>
        </div>
      )}

      {/* Play / Pause OSD icon (brief center indicator) */}
      {!loadError && !isPlaying && isLoaded && !seekOsd && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 15,
          }}
        >
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: "50%",
              background: "rgba(0,0,0,0.65)",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid rgba(255,255,255,0.3)",
            }}
          >
            {/* Pause icon — two vertical bars */}
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" rx="1"/>
              <rect x="14" y="4" width="4" height="16" rx="1"/>
            </svg>
          </div>
        </div>
      )}

      {/* Top control overlay: back + title */}
      {!loadError && showControls && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            background: "linear-gradient(to bottom, rgba(0,0,0,0.88) 0%, transparent 100%)",
            padding: "calc(env(safe-area-inset-top, 0px) + clamp(14px, 3vw, 28px)) var(--tv-safe-h, 60px) clamp(32px, 6vw, 60px)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "clamp(10px, 2vw, 16px)" }}>
            <button
              style={{
                background: "rgba(255,255,255,0.12)",
                border: "none",
                borderRadius: 10,
                padding: "clamp(8px, 1.6vw, 10px) clamp(12px, 2.4vw, 16px)",
                color: "#fff",
                fontSize: "clamp(14px, 2vw, 16px)",
                cursor: "pointer",
                pointerEvents: "auto",
                backdropFilter: "blur(4px)",
                minHeight: 40,
                flexShrink: 0,
              }}
              onClick={onBack}
              aria-label="Back"
            >
              ← Back
            </button>
            <h2
              style={{
                fontSize: "clamp(15px, 2.6vw, 28px)",
                fontWeight: 700,
                color: "#fff",
                flex: 1,
                margin: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                textShadow: "0 2px 12px rgba(0,0,0,0.6)",
              }}
              title={title}
            >
              {title}
            </h2>
          </div>
        </div>
      )}

      {/* Bottom hint bar */}
      {!loadError && (
        <div
          className="tt-hide-on-touch"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 100%)",
            padding: "clamp(32px, 6vw, 60px) var(--tv-safe-h, 60px) calc(env(safe-area-inset-bottom, 0px) + clamp(16px, 2.4vw, 24px))",
            pointerEvents: "none",
            opacity: showControls ? 1 : 0,
            transition: "opacity 0.3s ease",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            {[
              { key: isPlaying ? "⏸ SPACE" : "▶ SPACE", label: isPlaying ? "Pause" : "Play" },
              { key: "⏮ ←←", label: `−${SEEK_STEP_SECS}s` },
              { key: "⏭ →→", label: `+${SEEK_STEP_SECS}s` },
              { key: "ESC / BACK", label: "Exit" },
            ].map((h) => (
              <div key={h.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <kbd style={{ background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 6, padding: "3px 8px", fontSize: "clamp(11px, 1.2vw, 14px)", color: "rgba(255,255,255,0.65)", fontFamily: "inherit" }}>
                  {h.key}
                </kbd>
                <span style={{ fontSize: "clamp(12px, 1.2vw, 14px)", color: "rgba(255,255,255,0.35)" }}>{h.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
