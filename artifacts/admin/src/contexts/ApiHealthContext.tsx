import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiUrl } from "@/lib/api-base";

// ── Cross-module event protocol ─────────────────────────────────────────────
// `adminApi.ts` (and any other API caller that wants to participate) dispatch
// these on `window` to signal API health transitions without taking a hard
// dependency on this React context. The context listens, debounces, and
// drives the global reconnection banner.
//
// Decoupling via window events lets non-React code (the upload engine, raw
// fetch wrappers in legacy pages) report health without importing React.
export const API_HEALTH_DEGRADED_EVENT = "temple-tv-api-degraded";
export const API_HEALTH_HEALTHY_EVENT = "temple-tv-api-healthy";

export interface ApiDegradedDetail {
  /** Path or URL that failed, for diagnostics. */
  source: string;
  /** Human-readable reason from the failure site. */
  reason: string;
}

export type ApiHealthStatus = "healthy" | "degraded" | "recovering";

export interface ApiHealthState {
  status: ApiHealthStatus;
  /** Wall-clock ms when the current degraded period started. */
  degradedSinceMs: number | null;
  /** Last failure reason surfaced by an API caller. */
  lastReason: string | null;
  /** Last failed source (path/URL), for the diagnostic line. */
  lastSource: string | null;
  /** How many health-probe attempts the provider has made in this window. */
  probeAttempt: number;
  /** Forces an immediate health check (resets the backoff). */
  retryNow: () => void;
}

const ApiHealthContext = createContext<ApiHealthState | null>(null);

// Backoff schedule for health probes once we know the API is degraded.
// Mirrors AuthGate's schedule so both surfaces recover on the same cadence.
// Caps at 15s so a long outage doesn't pound the API once it returns.
const PROBE_BACKOFF_MS = [3_000, 5_000, 8_000, 15_000] as const;

// Hit /api/healthz directly — it's the lightest possible endpoint, public
// (no auth header needed), and serves as the canonical reachability signal
// for the API server.
async function probeApiHealthz(timeoutMs = 4_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl("/healthz"), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function ApiHealthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ApiHealthStatus>("healthy");
  const [lastReason, setLastReason] = useState<string | null>(null);
  const [lastSource, setLastSource] = useState<string | null>(null);
  const [degradedSinceMs, setDegradedSinceMs] = useState<number | null>(null);
  const [probeAttempt, setProbeAttempt] = useState(0);

  // Probe scheduling state. Refs avoid effect re-runs that would reset the
  // attempt counter on every state change.
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const statusRef = useRef<ApiHealthStatus>("healthy");
  statusRef.current = status;

  const clearProbeTimer = useCallback(() => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
  }, []);

  const scheduleProbe = useCallback(
    (delayOverrideMs?: number) => {
      clearProbeTimer();
      const idx = Math.min(attemptRef.current, PROBE_BACKOFF_MS.length - 1);
      const delay = delayOverrideMs ?? PROBE_BACKOFF_MS[idx];
      probeTimerRef.current = setTimeout(async () => {
        probeTimerRef.current = null;
        attemptRef.current += 1;
        setProbeAttempt(attemptRef.current);
        const ok = await probeApiHealthz();
        if (ok) {
          // Brief "recovering" pulse so the banner can show "Connection
          // restored" before disappearing — purely cosmetic feedback.
          attemptRef.current = 0;
          setStatus("recovering");
          setProbeAttempt(0);
          setLastReason(null);
          setLastSource(null);
          setDegradedSinceMs(null);
          setTimeout(() => {
            // Only flip to healthy if no fresh failure arrived in the
            // intervening 1.5s. Otherwise stay in whatever state the new
            // failure put us in.
            if (statusRef.current === "recovering") {
              setStatus("healthy");
            }
          }, 1_500);
        } else if (statusRef.current === "degraded") {
          // Still down — schedule the next probe.
          scheduleProbe();
        }
      }, delay);
    },
    [clearProbeTimer],
  );

  const retryNow = useCallback(() => {
    if (statusRef.current !== "degraded") return;
    // Reset the backoff and probe immediately. The user explicitly asked.
    attemptRef.current = 0;
    setProbeAttempt(0);
    scheduleProbe(0);
  }, [scheduleProbe]);

  // Listen for cross-module health events.
  useEffect(() => {
    const onDegraded = (ev: Event) => {
      const detail = (ev as CustomEvent<ApiDegradedDetail>).detail ?? {
        source: "unknown",
        reason: "API request failed",
      };
      setLastReason(detail.reason);
      setLastSource(detail.source);
      // Only kick off probing on the first failure of an outage. Subsequent
      // failures during the same outage just refresh the reason text.
      if (statusRef.current !== "degraded") {
        attemptRef.current = 0;
        setProbeAttempt(0);
        setDegradedSinceMs(Date.now());
        setStatus("degraded");
        scheduleProbe(PROBE_BACKOFF_MS[0]);
      }
    };
    const onHealthy = () => {
      // A successful API call from anywhere in the app means the API is up.
      // Snap straight to healthy without waiting for the next scheduled probe.
      if (statusRef.current === "degraded" || statusRef.current === "recovering") {
        clearProbeTimer();
        attemptRef.current = 0;
        setProbeAttempt(0);
        setLastReason(null);
        setLastSource(null);
        setDegradedSinceMs(null);
        setStatus("healthy");
      }
    };
    window.addEventListener(API_HEALTH_DEGRADED_EVENT, onDegraded);
    window.addEventListener(API_HEALTH_HEALTHY_EVENT, onHealthy);
    return () => {
      window.removeEventListener(API_HEALTH_DEGRADED_EVENT, onDegraded);
      window.removeEventListener(API_HEALTH_HEALTHY_EVENT, onHealthy);
      clearProbeTimer();
    };
  }, [scheduleProbe, clearProbeTimer]);

  const value = useMemo<ApiHealthState>(
    () => ({
      status,
      degradedSinceMs,
      lastReason,
      lastSource,
      probeAttempt,
      retryNow,
    }),
    [status, degradedSinceMs, lastReason, lastSource, probeAttempt, retryNow],
  );

  return (
    <ApiHealthContext.Provider value={value}>{children}</ApiHealthContext.Provider>
  );
}

export function useApiHealth(): ApiHealthState {
  const ctx = useContext(ApiHealthContext);
  if (!ctx) {
    throw new Error("useApiHealth must be used within <ApiHealthProvider>");
  }
  return ctx;
}

// Helper for non-React modules to signal degradation/health without having
// to construct CustomEvents themselves. Safe to call from any environment
// that has a `window` (no-op in SSR/Node).
export function reportApiDegraded(source: string, reason: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ApiDegradedDetail>(API_HEALTH_DEGRADED_EVENT, {
      detail: { source, reason },
    }),
  );
}

export function reportApiHealthy(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(API_HEALTH_HEALTHY_EVENT));
}
