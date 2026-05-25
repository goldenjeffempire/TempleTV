import { useEffect, useState } from "react";
import type { EmergencyAlertData } from "../components/EmergencyAlert";
import { resolveApiOrigin } from "../lib/api";

/**
 * Listens for EMERGENCY_BROADCAST signals on the omega-signal SSE/WS channel
 * and maintains the active emergency alert state for the TV app.
 *
 * Also polls /api/emergency/active on mount so that viewers who connect
 * mid-alert immediately see any currently active alert.
 *
 * Dismissal: info/warning alerts can be dismissed locally. critical/emergency
 * alerts can only be cleared by the server sending a NODE_HEALTH_CHANGED
 * signal with `dismissed: true`.
 */
export function useEmergencyAlerts() {
  const [activeAlert, setActiveAlert] = useState<EmergencyAlertData | null>(null);

  // Fetch current state on mount
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${resolveApiOrigin()}/api/emergency/active`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((alerts: Array<{
        id: string; title: string; message: string; severity: string; expiresAt: string | null;
      }>) => {
        const active = alerts[0];
        if (active) {
          setActiveAlert({
            alertId: active.id,
            title: active.title,
            message: active.message,
            severity: active.severity as EmergencyAlertData["severity"],
            expiresAt: active.expiresAt,
          });
        }
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        /* ignore other errors — non-critical on-mount fetch */
      });
    return () => ctrl.abort();
  }, []);

  // Listen for omega-signals pushed from the existing SSE/WS gateways.
  // The broadcast.routes SSE endpoint already fans out omega-signals via
  // the `signalBus`. We subscribe here using the /realtime/sse endpoint.
  useEffect(() => {
    let active = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let currentEs: EventSource | null = null;

    function connect() {
      if (!active) return;
      const es = new EventSource(`${resolveApiOrigin()}/api/realtime/sse`);
      currentEs = es;

      es.addEventListener("omega-signal", (evt: MessageEvent) => {
        try {
          const signal = JSON.parse(evt.data) as {
            type: string;
            payload?: Record<string, unknown>;
          };

          if (signal.type === "EMERGENCY_BROADCAST" && signal.payload) {
            const p = signal.payload;
            setActiveAlert({
              alertId: String(p.alertId ?? ""),
              title: String(p.title ?? "Emergency"),
              message: String(p.message ?? ""),
              severity: (p.severity as EmergencyAlertData["severity"]) ?? "warning",
              expiresAt: p.expiresAt ? String(p.expiresAt) : null,
            });
          }

          if (signal.type === "NODE_HEALTH_CHANGED" && signal.payload?.dismissed) {
            const dismissedId = signal.payload.alertId;
            setActiveAlert((prev) => (prev && prev.alertId === dismissedId ? null : prev));
          }
        } catch { /* ignore parse errors */ }
      });

      es.onerror = () => {
        es.close();
        if (active) {
          retryTimeout = setTimeout(connect, 6_000);
        }
      };
    }

    connect();

    return () => {
      active = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      currentEs?.close();
    };
  }, []);

  const dismiss = () => {
    setActiveAlert((prev) => {
      if (!prev) return null;
      if (prev.severity === "critical" || prev.severity === "emergency") return prev;
      return null;
    });
  };

  return { activeAlert, dismiss };
}
