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

/**
 * Status values the banner cares about:
 *
 *   • healthy    — everything reachable, no banner.
 *   • deploying  — the API instance is in its drain window (the new
 *                  /healthz returned `draining`) or in the brief
 *                  connection-refused gap that always immediately follows
 *                  a drain. Calm blue "Updating — viewers unaffected" banner.
 *                  This is the most important UX win: routine restarts no
 *                  longer look like outages.
 *   • degraded   — genuine failure (db_down, network error not preceded by
 *                  a drain, sustained 5xx). Amber "API connection lost" banner
 *                  with attempt counter and Retry-now.
 *   • recovering — brief green pulse after recovery, before going healthy.
 */
export type ApiHealthStatus = "healthy" | "deploying" | "degraded" | "recovering";

export interface ApiHealthState {
  status: ApiHealthStatus;
  /** Wall-clock ms when the current non-healthy period started. */
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

// While in `deploying`, probe more aggressively. A typical drain+restart
// completes in ~5–10s so we want to catch the recovery quickly.
const DEPLOY_PROBE_BACKOFF_MS = [1_500, 2_000, 3_000, 5_000] as const;

// If we've been "deploying" for longer than this, treat it as a real outage
// and escalate to `degraded`. Most rolling deploys finish well under 30s.
const DEPLOY_ESCALATION_MS = 60_000;

// After a confirmed `draining` probe, treat any subsequent network failures
// (connection refused, abort) as part of the same deploy for this window.
// This covers the gap between the old process exiting and the new one
// accepting connections.
const POST_DRAIN_GRACE_MS = 30_000;

type HealthPhase = "ok" | "draining" | "starting" | "db_down" | "unknown";

interface HealthProbeResult {
  /** Did the probe receive any HTTP response (even 503)? */
  reachable: boolean;
  /** Is the API ready to serve traffic right now (HTTP 200)? */
  ok: boolean;
  /** Server-reported phase from the response body (when reachable). */
  phase: HealthPhase;
}

/**
 * Probe `/healthz` and parse the new richer response body so we can
 * distinguish a planned drain from a real outage.
 *
 * The endpoint returns:
 *   200 {status:"ok",       phase:"ready"}
 *   503 {status:"starting", phase:"starting"}
 *   503 {status:"draining", phase:"draining"}
 *   503 {status:"db_down",  phase:"ready"}
 *
 * We map the body's `status` field to a simpler enum the state machine cares
 * about. If the body is unparseable (network error, intermediate proxy 5xx
 * with HTML body), fall back to `unknown`.
 */
async function probeApiHealth(timeoutMs = 4_000): Promise<HealthProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl("/healthz"), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    let phase: HealthPhase = "unknown";
    try {
      const body = (await res.json()) as { status?: unknown };
      const s = typeof body?.status === "string" ? body.status : "";
      if (s === "ok") phase = "ok";
      else if (s === "draining") phase = "draining";
      else if (s === "starting") phase = "starting";
      else if (s === "db_down") phase = "db_down";
    } catch {
      // Body wasn't JSON (e.g. an upstream proxy 502 page). Leave as unknown.
    }
    return { reachable: true, ok: res.ok, phase };
  } catch {
    return { reachable: false, ok: false, phase: "unknown" };
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
  // Wall-clock ms of the most recent observed `draining` phase. Used to
  // hold `deploying` state through the connection-refused gap that
  // immediately follows a drain (old proc exited, new proc not yet
  // listening). Without this, the banner would flip to red mid-deploy.
  const lastDrainSeenMsRef = useRef<number | null>(null);
  const deployingSinceMsRef = useRef<number | null>(null);

  const clearProbeTimer = useCallback(() => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
  }, []);

  /**
   * Apply a probe result to the state machine. Returns the resolved status
   * so callers can decide whether to schedule another probe.
   */
  const applyProbeResult = useCallback(
    (result: HealthProbeResult): ApiHealthStatus => {
      const now = Date.now();

      // Healthy path — flush all degraded state.
      if (result.ok && result.phase === "ok") {
        attemptRef.current = 0;
        deployingSinceMsRef.current = null;
        setProbeAttempt(0);
        setLastReason(null);
        setLastSource(null);
        setDegradedSinceMs(null);
        // Brief "recovering" pulse so the banner shows "Connection restored"
        // (or "Update complete") before disappearing — purely cosmetic.
        setStatus("recovering");
        setTimeout(() => {
          if (statusRef.current === "recovering") setStatus("healthy");
        }, 1_500);
        return "recovering";
      }

      // Server explicitly told us it's draining or starting → planned restart.
      if (result.phase === "draining") {
        lastDrainSeenMsRef.current = now;
      }
      const isPlanned =
        result.phase === "draining" || result.phase === "starting";
      const recentlyDraining =
        lastDrainSeenMsRef.current !== null &&
        now - lastDrainSeenMsRef.current < POST_DRAIN_GRACE_MS;

      // Network error: if it follows a recent drain, keep treating as deploy.
      // Otherwise it's a real outage.
      const treatAsDeploy = isPlanned || (!result.reachable && recentlyDraining);

      if (treatAsDeploy) {
        if (deployingSinceMsRef.current === null) {
          deployingSinceMsRef.current = now;
        }
        // Escalate if the deploy is taking suspiciously long.
        if (now - deployingSinceMsRef.current > DEPLOY_ESCALATION_MS) {
          if (statusRef.current !== "degraded") {
            setStatus("degraded");
          }
          return "degraded";
        }
        if (statusRef.current !== "deploying") {
          if (degradedSinceMs === null) setDegradedSinceMs(now);
          setStatus("deploying");
        }
        return "deploying";
      }

      // Genuine failure — db_down, sustained 5xx, or network error with no
      // recent drain hint.
      deployingSinceMsRef.current = null;
      if (statusRef.current !== "degraded") {
        if (degradedSinceMs === null) setDegradedSinceMs(now);
        setStatus("degraded");
      }
      return "degraded";
    },
    [degradedSinceMs],
  );

  const scheduleProbe = useCallback(
    (delayOverrideMs?: number) => {
      clearProbeTimer();
      const isDeploy = statusRef.current === "deploying";
      const schedule = isDeploy ? DEPLOY_PROBE_BACKOFF_MS : PROBE_BACKOFF_MS;
      const idx = Math.min(attemptRef.current, schedule.length - 1);
      const delay = delayOverrideMs ?? schedule[idx];
      probeTimerRef.current = setTimeout(async () => {
        probeTimerRef.current = null;
        attemptRef.current += 1;
        setProbeAttempt(attemptRef.current);
        const result = await probeApiHealth();
        const next = applyProbeResult(result);
        // Keep probing until we're healthy/recovering.
        if (next === "deploying" || next === "degraded") {
          scheduleProbe();
        }
      }, delay);
    },
    [clearProbeTimer, applyProbeResult],
  );

  const retryNow = useCallback(() => {
    if (statusRef.current === "healthy" || statusRef.current === "recovering")
      return;
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

      // Already in a non-healthy state — just refresh the reason and let the
      // probe loop continue. (We still kick a fresh probe so the UI updates
      // quickly if the server has since transitioned to draining.)
      if (statusRef.current !== "healthy") {
        scheduleProbe(0);
        return;
      }

      // First failure of a new outage. Probe immediately to classify it as
      // deploy vs degraded BEFORE showing any banner — this avoids the
      // amber-flash-then-blue UX glitch.
      attemptRef.current = 0;
      setProbeAttempt(0);
      setDegradedSinceMs(Date.now());
      // Start in `deploying` if we recently saw a drain; otherwise wait for
      // the immediate probe below to classify. We can't show "healthy" while
      // waiting (a request did just fail), so default to the calmer state
      // and let the probe upgrade to `degraded` if needed.
      const recentlyDraining =
        lastDrainSeenMsRef.current !== null &&
        Date.now() - lastDrainSeenMsRef.current < POST_DRAIN_GRACE_MS;
      setStatus(recentlyDraining ? "deploying" : "degraded");
      if (recentlyDraining && deployingSinceMsRef.current === null) {
        deployingSinceMsRef.current = Date.now();
      }
      scheduleProbe(0);
    };
    const onHealthy = () => {
      // A successful API call from anywhere in the app means the API is up.
      // Snap straight to healthy without waiting for the next scheduled probe.
      if (statusRef.current === "healthy") return;
      clearProbeTimer();
      attemptRef.current = 0;
      deployingSinceMsRef.current = null;
      setProbeAttempt(0);
      setLastReason(null);
      setLastSource(null);
      setDegradedSinceMs(null);
      setStatus("healthy");
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
