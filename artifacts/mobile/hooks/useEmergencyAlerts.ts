import { useEffect, useState } from "react";
import type { EmergencyAlertData } from "@/components/EmergencyBanner";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

/**
 * Polls /api/emergency/active on mount and subscribes to the SSE gateway
 * for real-time EMERGENCY_BROADCAST signals on mobile.
 *
 * Retry interval is 6 s (matches TV's useEmergencyAlerts) — a balance
 * between reconnect latency and avoiding battery/CPU churn on native.
 */
export function useEmergencyAlerts() {
  const [activeAlert, setActiveAlert] = useState<EmergencyAlertData | null>(null);

  useEffect(() => {
    const apiBase = getApiBase();
    if (!apiBase) return;
    fetchWithRetry(`${apiBase}/api/emergency/active`, {}, { maxRetries: 3 })
      .then((r) => (r.ok ? r.json() : []))
      .then((alerts: Array<{ id: string; title: string; message: string; severity: string; expiresAt: string | null }>) => {
        const a = alerts[0];
        if (a) {
          setActiveAlert({
            alertId: a.id,
            title: a.title,
            message: a.message,
            severity: a.severity as EmergencyAlertData["severity"],
            expiresAt: a.expiresAt,
          });
        }
      })
      .catch((err: unknown) => {
        if (__DEV__) {
          console.warn("[useEmergencyAlerts] initial fetch failed — real-time SSE will still deliver new alerts:", err);
        }
      });
  }, []);

  useEffect(() => {
    const apiBase = getApiBase();
    if (!apiBase) return;

    let active = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let es: { addEventListener(type: string, handler: (evt: { data: string }) => void): void; close?(): void } | null = null;

    const connect = () => {
      if (!active) return;
      try {
        const EventSource = require("react-native-sse").default;
        es = new EventSource(`${apiBase}/api/realtime/sse`);

        es.addEventListener("omega-signal", (evt: { data: string }) => {
          try {
            const signal = JSON.parse(evt.data) as { type: string; payload?: Record<string, unknown> };
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
              setActiveAlert((prev) => (prev?.alertId === String(signal.payload?.alertId) ? null : prev));
            }
          } catch {}
        });

        es.addEventListener("error", () => {
          es?.close?.();
          if (active) retryTimeout = setTimeout(connect, 6_000);
        });
      } catch {
        // react-native-sse not available — polling-only
      }
    };

    connect();
    return () => {
      active = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      es?.close?.();
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
