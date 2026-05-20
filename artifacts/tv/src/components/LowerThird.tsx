import { useEffect, useState } from "react";

interface LowerThirdProps {
  name: string;
  title?: string | null;
  /** ms delay before sliding in. Default 500 */
  delayMs?: number;
}

/**
 * Broadcast lower-third name/title overlay.
 * Slides in from the left edge 500ms after mount, matching the professional
 * lower-third animation used by CNN, BBC, Al Jazeera, and major networks.
 * Automatically disappears and re-animates when `name` changes.
 */
export function LowerThird({ name, title, delayMs = 500 }: LowerThirdProps) {
  const [state, setState] = useState<"hidden" | "entering" | "visible" | "leaving">("hidden");

  useEffect(() => {
    setState("hidden");
    const t1 = setTimeout(() => setState("entering"), 100);
    const t2 = setTimeout(() => setState("visible"), delayMs + 100);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [name, title, delayMs]);

  const translateX = state === "hidden" || state === "leaving" ? "-105%" : "0%";
  const opacity = state === "visible" || state === "entering" ? 1 : 0;

  return (
    <div
      aria-label={`Lower third: ${name}`}
      style={{
        position: "absolute",
        left: "clamp(24px, 3vw, 48px)",
        bottom: "clamp(60px, 9vh, 100px)",
        pointerEvents: "none",
        zIndex: 7,
        transform: `translateX(${translateX})`,
        opacity,
        transition: "transform 550ms cubic-bezier(0.16,1,0.3,1), opacity 350ms ease-out",
      }}
    >
      {/* Accent bar */}
      <div
        style={{
          width: "clamp(3px, 0.35vw, 5px)",
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          background: "#DC2626",
          borderRadius: 2,
        }}
      />
      {/* Content */}
      <div
        style={{
          marginLeft: "clamp(10px, 1.2vw, 16px)",
          background: "rgba(10, 10, 16, 0.82)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          borderRadius: "0 4px 4px 0",
          padding: "clamp(8px, 1vw, 12px) clamp(14px, 2vw, 24px)",
          minWidth: "clamp(160px, 20vw, 280px)",
          maxWidth: "clamp(280px, 35vw, 480px)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            color: "#fff",
            fontSize: "clamp(13px, 1.5vw, 20px)",
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: "-0.01em",
          }}
        >
          {name}
        </div>
        {title && (
          <div
            style={{
              color: "rgba(255,255,255,0.7)",
              fontSize: "clamp(10px, 1.05vw, 14px)",
              fontWeight: 500,
              marginTop: "clamp(2px, 0.3vw, 4px)",
              letterSpacing: "0.01em",
            }}
          >
            {title}
          </div>
        )}
      </div>
    </div>
  );
}
