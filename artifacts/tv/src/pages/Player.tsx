import { useEffect, useRef, useState } from "react";

interface PlayerProps {
  videoId: string;
  title: string;
  onBack: () => void;
}

const LOAD_TIMEOUT_MS = 12_000;
const MAX_AUTO_RETRIES = 2;

export function Player({ videoId, title, onBack }: PlayerProps) {
  const [showControls, setShowControls] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [autoRetries, setAutoRetries] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetHideTimer = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowControls(true);
    hideTimer.current = setTimeout(() => setShowControls(false), 4000);
  };

  // Watchdog: if iframe never reports load within timeout, treat as failed
  useEffect(() => {
    setIsLoaded(false);
    setLoadError(null);
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(() => {
      if (!isLoaded) {
        if (autoRetries < MAX_AUTO_RETRIES) {
          setAutoRetries((n) => n + 1);
          setRetryKey((k) => k + 1);
        } else {
          setLoadError(
            "We couldn't start playback. Please check the connection and try again.",
          );
        }
      }
    }, LOAD_TIMEOUT_MS);

    return () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey, videoId]);

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
      style={{ background: "#000", zIndex: 100 }}
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
            gap: 24,
            padding: "0 60px",
            textAlign: "center",
          }}
        >
          <div
            aria-hidden
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              background: "rgba(255,255,255,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
            }}
          >
            ⚠️
          </div>
          <h2 style={{ fontSize: 32, fontWeight: 700, color: "#fff", margin: 0 }}>
            Playback unavailable
          </h2>
          <p style={{ fontSize: 18, color: "rgba(255,255,255,0.7)", maxWidth: 720 }}>
            {loadError}
          </p>
          <div style={{ display: "flex", gap: 16 }}>
            <button
              autoFocus
              onClick={handleManualRetry}
              style={{
                background: "hsl(0 78% 50%)",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "14px 32px",
                fontSize: 18,
                fontWeight: 700,
                cursor: "pointer",
                outline: "none",
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
                padding: "14px 32px",
                fontSize: 18,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Back
            </button>
          </div>
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", marginTop: 8 }}>
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
            padding: "28px 48px 60px",
            pointerEvents: "none",
          }}
        >
          <div className="flex items-center gap-4">
            <button
              style={{
                background: "rgba(255,255,255,0.12)",
                border: "none",
                borderRadius: 10,
                padding: "10px 16px",
                color: "#fff",
                fontSize: 16,
                cursor: "pointer",
                pointerEvents: "auto",
                backdropFilter: "blur(4px)",
              }}
              onClick={onBack}
            >
              ← Back
            </button>
            <h2
              style={{ fontSize: 28, fontWeight: 700, color: "#fff", flex: 1 }}
            >
              {title}
            </h2>
          </div>
        </div>
      )}

      {!loadError && (
        <div
          className="absolute inset-x-0 bottom-0"
          style={{
            background:
              "linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)",
            padding: "60px 48px 24px",
            pointerEvents: "none",
            opacity: showControls ? 1 : 0,
            transition: "opacity 0.3s ease",
          }}
        >
          <p style={{ fontSize: 16, color: "rgba(255,255,255,0.6)" }}>
            Press <strong style={{ color: "#fff" }}>ESC</strong> or{" "}
            <strong style={{ color: "#fff" }}>BACK</strong> to return
          </p>
        </div>
      )}
    </div>
  );
}
