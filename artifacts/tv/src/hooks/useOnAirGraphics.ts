import { useEffect, useRef, useState } from "react";
import { resolveApiOrigin } from "../lib/api";

export interface ActiveGraphic {
  id: string;
  type: "ticker" | "lower_third" | "bug_text";
  content: string;
  subContent: string | null;
  durationSecs: number | null;
}

/**
 * Subscribes to the /api/graphics/events SSE feed and maintains the current
 * set of active on-air graphics for a given channel.
 * Auto-reconnects on disconnect. Graceful fallback to empty state on error.
 */
export function useOnAirGraphics(channelId = "temple-tv-live") {
  const [graphics, setGraphics] = useState<ActiveGraphic[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let active = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (!active) return;
      const url = `${resolveApiOrigin()}/api/graphics/events?channelId=${channelId}`;
      const es = new EventSource(url);
      esRef.current = es;

      const handleSnapshot = (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          if (Array.isArray(data.allActive)) {
            setGraphics(data.allActive);
          }
        } catch { /* ignore parse errors */ }
      };

      const handleActivated = (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.graphic) {
            setGraphics((prev) => {
              const filtered = prev.filter((g) => g.type !== data.graphic.type);
              return [...filtered, data.graphic];
            });
          }
        } catch { /* ignore */ }
      };

      const handleDeactivated = (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.graphic?.id) {
            setGraphics((prev) => prev.filter((g) => g.id !== data.graphic.id));
          }
        } catch { /* ignore */ }
      };

      es.addEventListener("graphics-snapshot", handleSnapshot);
      es.addEventListener("graphic-activated", handleActivated);
      es.addEventListener("graphic-deactivated", handleDeactivated);

      es.onerror = () => {
        es.close();
        if (active) {
          retryTimeout = setTimeout(connect, 5_000);
        }
      };
    }

    connect();

    return () => {
      active = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      esRef.current?.close();
    };
  }, [channelId]);

  const ticker = graphics.find((g) => g.type === "ticker") ?? null;
  const lowerThird = graphics.find((g) => g.type === "lower_third") ?? null;
  const bugText = graphics.find((g) => g.type === "bug_text") ?? null;

  return { graphics, ticker, lowerThird, bugText };
}
