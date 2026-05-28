/**
 * PipIndicator — global floating badge shown whenever a native PiP window is open.
 *
 * Mounts at the bottom-centre of the screen (outside the keyed screen div in
 * App.tsx so it survives route transitions). Offers two actions:
 *   • "Return to Full Screen" — exits PiP and navigates back to the live player
 *   • ✕ — exits PiP without navigating (user stays on current screen)
 *
 * The component self-shows/self-hides by listening to the native
 * `enterpictureinpicture` / `leavepictureinpicture` DOM events so it
 * stays accurate even when the user closes the OS-native PiP chrome.
 */

import { useEffect, useState, useCallback } from "react";

interface PipIndicatorProps {
  onReturnToPlayer: () => void;
}

export function PipIndicator({ onReturnToPlayer }: PipIndicatorProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const check = () => setVisible(!!document.pictureInPictureElement);
    check();
    document.addEventListener("enterpictureinpicture", check);
    document.addEventListener("leavepictureinpicture", check);
    return () => {
      document.removeEventListener("enterpictureinpicture", check);
      document.removeEventListener("leavepictureinpicture", check);
    };
  }, []);

  const exitPiP = useCallback(() => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
  }, []);

  const returnToPlayer = useCallback(() => {
    exitPiP();
    onReturnToPlayer();
  }, [exitPiP, onReturnToPlayer]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: "max(env(safe-area-inset-bottom, 0px), clamp(16px, 3vh, 32px))",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "rgba(10,5,20,0.94)",
        border: "1px solid rgba(167,139,250,0.28)",
        borderRadius: 999,
        padding: "clamp(8px, 1.2vh, 12px) clamp(12px, 1.8vw, 18px)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: "0 8px 36px rgba(0,0,0,0.65), 0 0 0 1px rgba(109,40,217,0.18)",
        animation: "pip-banner-in 320ms cubic-bezier(0.16,1,0.3,1)",
        pointerEvents: "auto",
        maxWidth: "calc(100vw - 48px)",
        userSelect: "none",
      }}
    >
      {/* Branded pulse dot */}
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          width: 8,
          height: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: "#c4b5fd",
            opacity: 0.65,
            animation: "pip-ping 1.4s cubic-bezier(0,0,0.2,1) infinite",
          }}
        />
        <span
          style={{
            position: "relative",
            borderRadius: "50%",
            width: "100%",
            height: "100%",
            background: "#e9d5ff",
            boxShadow: "0 0 5px rgba(233,213,255,0.7)",
            display: "inline-flex",
          }}
        />
      </span>

      {/* Label */}
      <span
        style={{
          fontSize: "clamp(11px, 1.2vw, 14px)",
          fontWeight: 600,
          color: "rgba(255,255,255,0.82)",
          whiteSpace: "nowrap",
          letterSpacing: "0.01em",
        }}
      >
        Live broadcast in Picture-in-Picture
      </span>

      <div
        style={{
          width: 1,
          height: 18,
          background: "rgba(255,255,255,0.12)",
          flexShrink: 0,
        }}
      />

      {/* Return to full screen */}
      <button
        onClick={returnToPlayer}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          background: "rgba(109,40,217,0.85)",
          border: "1px solid rgba(167,139,250,0.35)",
          borderRadius: 999,
          padding: "clamp(4px,0.6vh,7px) clamp(10px,1.4vw,14px)",
          color: "#fff",
          fontSize: "clamp(10px, 1vw, 13px)",
          fontWeight: 700,
          cursor: "pointer",
          letterSpacing: "0.01em",
          transition: "background 150ms ease, box-shadow 150ms ease",
          whiteSpace: "nowrap",
          flexShrink: 0,
          fontFamily: "inherit",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "rgba(124,58,237,0.95)";
          (e.currentTarget as HTMLButtonElement).style.boxShadow =
            "0 4px 18px rgba(109,40,217,0.5)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "rgba(109,40,217,0.85)";
          (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
        }}
        aria-label="Return to full-screen broadcast player"
      >
        {/* Expand/fullscreen icon */}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          style={{ width: 11, height: 11, flexShrink: 0 }}
          aria-hidden
        >
          <path
            d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Return to Full Screen
      </button>

      {/* Close / exit PiP only */}
      <button
        onClick={exitPiP}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          background: "rgba(255,255,255,0.07)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: "50%",
          color: "rgba(255,255,255,0.45)",
          fontSize: 12,
          cursor: "pointer",
          transition: "background 150ms ease, color 150ms ease",
          flexShrink: 0,
          fontFamily: "inherit",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "rgba(255,255,255,0.16)";
          (e.currentTarget as HTMLButtonElement).style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "rgba(255,255,255,0.07)";
          (e.currentTarget as HTMLButtonElement).style.color =
            "rgba(255,255,255,0.45)";
        }}
        title="Exit Picture-in-Picture"
        aria-label="Exit Picture-in-Picture"
      >
        ✕
      </button>

      <style>{`
        @keyframes pip-banner-in {
          from { opacity: 0; transform: translate(-50%, 20px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }
        @keyframes pip-ping {
          75%, 100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
