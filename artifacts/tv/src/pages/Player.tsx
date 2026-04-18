import { useEffect, useRef, useState } from "react";

interface PlayerProps {
  videoId: string;
  title: string;
  onBack: () => void;
}

export function Player({ videoId, title, onBack }: PlayerProps) {
  const [showControls, setShowControls] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetHideTimer = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowControls(true);
    hideTimer.current = setTimeout(() => setShowControls(false), 4000);
  };

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
      } else {
        resetHideTimer();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [onBack, showControls]);

  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&controls=0&rel=0&modestbranding=1&iv_load_policy=3&cc_load_policy=0&playsinline=1`;

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center"
      style={{ background: "#000", zIndex: 100 }}
    >
      <iframe
        src={embedUrl}
        title={title}
        allow="autoplay; encrypted-media; fullscreen"
        allowFullScreen
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
        }}
      />

      {showControls && (
        <div
          className="absolute inset-x-0 top-0"
          style={{
            background: "linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, transparent 100%)",
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
            <h2 style={{ fontSize: 28, fontWeight: 700, color: "#fff", flex: 1 }}>{title}</h2>
          </div>
        </div>
      )}

      <div
        className="absolute inset-x-0 bottom-0"
        style={{
          background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)",
          padding: "60px 48px 24px",
          pointerEvents: "none",
          opacity: showControls ? 1 : 0,
          transition: "opacity 0.3s ease",
        }}
      >
        <p style={{ fontSize: 16, color: "rgba(255,255,255,0.6)" }}>
          Press <strong style={{ color: "#fff" }}>ESC</strong> or <strong style={{ color: "#fff" }}>BACK</strong> to return
        </p>
      </div>
    </div>
  );
}
