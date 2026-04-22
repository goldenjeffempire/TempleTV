import { useEffect, useRef, useState } from "react";

interface PlayerProps {
  videoId: string;
  title: string;
  onBack: () => void;
}

// Tightened from 12s to 8s — Smart-TV users notice anything over ~6s as
// "broken." If the iframe hasn't reported load by 8s we already know we
// need to retry from a different network path.
const LOAD_TIMEOUT_MS = 8_000;
const MAX_AUTO_RETRIES = 3;
// Exponential backoff between auto-retries (ms). The first retry fires
// almost immediately to recover from a single dropped TLS handshake;
// later retries space out so we don't hammer the YouTube edge.
const RETRY_BACKOFF_MS = [400, 1500, 4000];

export function Player({ videoId, title, onBack }: PlayerProps) {
  const [showControls, setShowControls] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [autoRetries, setAutoRetries] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the deferred remount inside the watchdog so we can cancel it
  // if the user navigates away or the videoId changes mid-backoff.
  // Without this, a stray retry can fire after teardown and trigger a
  // ghost iframe remount on the next page.
  const retryRemountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetHideTimer = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowControls(true);
    hideTimer.current = setTimeout(() => setShowControls(false), 4000);
  };

  // Watchdog: if iframe never reports load within timeout, treat as failed
  // and schedule the next retry with exponential backoff.
  useEffect(() => {
    setIsLoaded(false);
    setLoadError(null);
    if (loadTimer.current) clearTimeout(loadTimer.current);
    if (retryRemountTimer.current) clearTimeout(retryRemountTimer.current);
    loadTimer.current = setTimeout(() => {
      if (!isLoaded) {
        if (autoRetries < MAX_AUTO_RETRIES) {
          const nextDelay = RETRY_BACKOFF_MS[autoRetries] ?? 4000;
          setAutoRetries((n) => n + 1);
          // Brief pause before remount so the previous iframe fully tears
          // down. Tracked in a ref so unmount/videoId-change cancels it.
          retryRemountTimer.current = setTimeout(
            () => setRetryKey((k) => k + 1),
            nextDelay,
          );
        } else {
          setLoadError(
            "We couldn't start playback. Please check the connection and try again.",
          );
        }
      }
    }, LOAD_TIMEOUT_MS);

    return () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
      if (retryRemountTimer.current) clearTimeout(retryRemountTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey, videoId]);

  // Auto-recover when the TV regains its network connection.
  useEffect(() => {
    const handleOnline = () => {
      if (loadError) {
        setAutoRetries(0);
        setLoadError(null);
        setRetryKey((k) => k + 1);
      }
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [loadError]);

  useEffect(() => {
    resetHideTimer();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Backspace" || e.key === "ArrowLeft") {
        if (e.key === "ArrowLeft" && !showControls) {
          resetHideTimer();
          return;
        }
        if (e.key === "Escape" || e.key === "Backspace") {
          e.preventDefault();
          onBack();
        }
      } else if (e.key === "Enter" && loadError) {
        e.preventDefault();
        setAutoRetries(0);
        setLoadError(null);
        setRetryKey((k) => k + 1);
      } else {
        resetHideTimer();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [onBack, showControls, loadError]);

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

  const handleManualRetry = () => {
    setAutoRetries(0);
    setLoadError(null);
    setRetryKey((k) => k + 1);
  };

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center"
      style={{
        background: "#000",
        zIndex: 100,
        // dvh handles mobile browser chrome (URL bar) collapsing properly;
        // falls back to vh on browsers without dynamic viewport units.
        height: "100dvh",
        width: "100vw",
      }}
    >
      {/* Cinematic loading veil — visible until the iframe reports ready */}
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
            background:
              "radial-gradient(circle at 50% 40%, #1a0010 0%, #050505 70%)",
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
          <p
            style={{
              fontSize: 14,
              letterSpacing: "0.18em",
              fontWeight: 700,
              color: "rgba(255,255,255,0.55)",
              textTransform: "uppercase",
            }}
          >
            {autoRetries > 0 ? "Reconnecting…" : "Preparing playback"}
          </p>
        </div>
      )}

      {!loadError && (
        <iframe
          key={retryKey}
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
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            // Prevent iOS Safari from over-zooming the iframe when the
            // user double-taps; YouTube handles its own gestures.
            touchAction: "manipulation",
          }}
        />
      )}

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
          <div
            aria-hidden
            style={{
              width: "clamp(48px, 8vw, 64px)",
              height: "clamp(48px, 8vw, 64px)",
              borderRadius: "50%",
              background: "rgba(255,255,255,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "clamp(22px, 4vw, 30px)",
            }}
          >
            ⚠️
          </div>
          <h2
            style={{
              fontSize: "clamp(20px, 4.2vw, 32px)",
              fontWeight: 700,
              color: "#fff",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Playback unavailable
          </h2>
          <p
            style={{
              fontSize: "clamp(14px, 2.2vw, 18px)",
              color: "rgba(255,255,255,0.7)",
              maxWidth: 560,
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {loadError}
          </p>
          <div
            style={{
              display: "flex",
              gap: "clamp(10px, 2vw, 16px)",
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <button
              autoFocus
              onClick={handleManualRetry}
              style={{
                background: "hsl(0 78% 50%)",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "clamp(12px, 2vw, 14px) clamp(22px, 4vw, 32px)",
                fontSize: "clamp(15px, 2.2vw, 18px)",
                fontWeight: 700,
                cursor: "pointer",
                outline: "none",
                minHeight: 44,
              }}
            >
              Try again
            </button>
            <button
              onClick={onBack}
              style={{
                background: "rgba(255,255,255,0.12)",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "clamp(12px, 2vw, 14px) clamp(22px, 4vw, 32px)",
                fontSize: "clamp(15px, 2.2vw, 18px)",
                fontWeight: 600,
                cursor: "pointer",
                minHeight: 44,
              }}
            >
              Back
            </button>
          </div>
          {/* Keyboard hint is irrelevant on touch — hide on small screens */}
          <p
            className="tt-hide-on-touch"
            style={{
              fontSize: 14,
              color: "rgba(255,255,255,0.4)",
              marginTop: 8,
            }}
          >
            Press <strong style={{ color: "#fff" }}>ENTER</strong> to retry,{" "}
            <strong style={{ color: "#fff" }}>BACK</strong> to return
          </p>
        </div>
      )}

      {!loadError && showControls && (
        <div
          className="absolute inset-x-0 top-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, transparent 100%)",
            // Top: respect notch/safe-area on iOS; horizontal scales with viewport.
            padding:
              "calc(env(safe-area-inset-top, 0px) + clamp(14px, 3vw, 28px)) clamp(16px, 4vw, 48px) clamp(32px, 6vw, 60px)",
            pointerEvents: "none",
          }}
        >
          <div
            className="flex items-center"
            style={{ gap: "clamp(10px, 2vw, 16px)" }}
          >
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
                // Truncate long titles on narrow screens
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

      {/* Bottom keyboard hint — hidden on touch devices where it's meaningless */}
      {!loadError && (
        <div
          className="absolute inset-x-0 bottom-0 tt-hide-on-touch"
          style={{
            background:
              "linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)",
            padding:
              "clamp(32px, 6vw, 60px) clamp(16px, 4vw, 48px) calc(env(safe-area-inset-bottom, 0px) + clamp(16px, 2.4vw, 24px))",
            pointerEvents: "none",
            opacity: showControls ? 1 : 0,
            transition: "opacity 0.3s ease",
          }}
        >
          <p
            style={{
              fontSize: "clamp(13px, 1.6vw, 16px)",
              color: "rgba(255,255,255,0.6)",
              margin: 0,
            }}
          >
            Press <strong style={{ color: "#fff" }}>ESC</strong> or{" "}
            <strong style={{ color: "#fff" }}>BACK</strong> to return
          </p>
        </div>
      )}
    </div>
  );
}
