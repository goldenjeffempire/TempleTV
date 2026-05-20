import { useEffect, useRef, useState } from "react";

interface TickerProps {
  text: string;
  /** pixels-per-second scroll speed. Default 60 */
  speed?: number;
}

/**
 * On-air ticker crawl — scrolls text continuously from right to left.
 * Mirrors the broadcast-standard lower-bar ticker seen on CNN, BBC, Sky News.
 * Renders as a fixed strip at the very bottom of the video surface.
 * Pointer-events disabled so it never intercepts remote-control focus.
 */
export function OnAirTicker({ text, speed = 60 }: TickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const animRef = useRef<number>(0);
  const posRef = useRef<number>(0);
  const startedRef = useRef<boolean>(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const t = setTimeout(() => setVisible(true), 400);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    const containerW = container.offsetWidth;
    const textW = textEl.scrollWidth;

    // Start the text just off the right edge
    posRef.current = containerW;
    textEl.style.transform = `translateX(${containerW}px)`;
    startedRef.current = true;

    let last: number | null = null;

    const tick = (now: number) => {
      if (last === null) last = now;
      const delta = (now - last) / 1000;
      last = now;

      posRef.current -= speed * delta;

      // Reset when the text is fully off the left edge; loop seamlessly
      if (posRef.current < -textW) {
        posRef.current = containerW;
      }

      if (textEl) {
        textEl.style.transform = `translateX(${posRef.current}px)`;
      }

      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animRef.current);
      last = null;
    };
  }, [text, speed]);

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: "clamp(26px, 3vh, 36px)",
        background: "rgba(220, 38, 38, 0.92)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 8,
        opacity: visible ? 1 : 0,
        transition: "opacity 500ms ease-out",
      }}
      aria-live="polite"
      aria-label="Ticker"
    >
      {/* TEMPLE TV label */}
      <div
        style={{
          flexShrink: 0,
          background: "rgba(0,0,0,0.35)",
          color: "#fff",
          fontSize: "clamp(8px, 0.9vw, 11px)",
          fontWeight: 900,
          letterSpacing: "0.15em",
          padding: "0 clamp(8px, 1vw, 14px)",
          height: "100%",
          display: "flex",
          alignItems: "center",
          borderRight: "1px solid rgba(255,255,255,0.2)",
          whiteSpace: "nowrap",
        }}
      >
        LIVE
      </div>
      {/* Scrolling content */}
      <div ref={containerRef} style={{ flex: 1, position: "relative", overflow: "hidden", height: "100%" }}>
        <span
          ref={textRef}
          style={{
            position: "absolute",
            whiteSpace: "nowrap",
            top: "50%",
            transform: "translateY(-50%)",
            color: "#fff",
            fontSize: "clamp(10px, 1.1vw, 13px)",
            fontWeight: 600,
            letterSpacing: "0.02em",
            willChange: "transform",
          }}
        >
          {text} &nbsp;&nbsp;&nbsp; ✦ &nbsp;&nbsp;&nbsp; {text}
        </span>
      </div>
    </div>
  );
}
