import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { tokenStore, forceRefreshToken } from "@/lib/api";
import { apiBase } from "@/lib/api-base";

export type SSEConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"   // HTTP API reachable but SSE channel unavailable
  | "offline";   // Both SSE and HTTP API unreachable

type SSEEventHandler = (data: unknown) => void;

export interface SSEActivityEntry {
  id: string;
  event: string;
  ts: number;
  summary: string;
}

export interface AdminLiveStatus {
  isLive: boolean;
  ytLive: boolean;
  ytVideoId: string | null;
  ytTitle: string | null;
  deviceCount: number;
  sseClients: number;
  liveOverride: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
    elapsedSecs: number;
    remainingSecs: number | null;
  } | null;
  ts: number;
}

interface SSEContextValue {
  state: SSEConnectionState;
  subscribe: (event: string, handler: SSEEventHandler) => () => void;
  lastStatusPayload: AdminLiveStatus | null;
  recentActivity: SSEActivityEntry[];
  /**
   * Immediately cancel any pending backoff timer, reset the attempt counter,
   * and attempt to (re)connect the admin SSE channel.
   *
   * Call this when external evidence (e.g. a WebSocket reconnect) confirms
   * the API server is reachable — no need to wait for the health-check poll
   * cycle to discover the server is back up.
   *
   * No-ops when already connected or while a connect() is in flight.
   */
  forceReconnect: () => void;
}

const SSEContext = createContext<SSEContextValue | null>(null);

// ── Timing / threshold constants ─────────────────────────────────────────────

// Maximum exponential-backoff cap. 30 s gives cold-start environments
// (Render free tier ~30 s) time to wake up without flooding the server.
const MAX_BACKOFF_MS = 30_000;

const ACTIVITY_BUFFER_SIZE = 30;

// Zombie-socket threshold. Server sends `heartbeat` every 10 s.
// 45 s = ~4.5 missed heartbeats — generous margin for background-tab
// timer throttling (Chrome ≥ 1 min, Safari can suspend timers entirely).
const HEARTBEAT_STALE_MS = 45_000;

// How long to defer "reconnecting"/"degraded"/"offline" label so brief
// blips (token refresh, server restart) never flash the UI.
// Only applies once we've previously connected; on the initial connect
// sequence we keep "connecting" state until attempt 4 to avoid showing
// "reconnecting" during normal dev-proxy warm-up (first 1-2 EventSource
// connections hang ~5s in the Vite proxy before succeeding).
const RECONNECTING_GRACE_MS = 2_000;

// How many failed attempts to allow before transitioning from "connecting"
// to "reconnecting". During the initial connect sequence the dev Vite proxy
// may drop the first 1-2 SSE connections; showing "connecting" is more
// accurate than "reconnecting" during that warm-up window.
const RECONNECTING_AFTER_ATTEMPTS = 3;

// If an EventSource is created but `open` never fires within this window,
// close it and schedule a reconnect. Guards against silent proxy hangs
// (Vite dev proxy accepting the TCP connection but never forwarding it)
// which otherwise keep the connection stuck for 5-11 seconds per attempt.
// 20 s gives the Replit preview proxy → Vite → API 3-hop chain enough
// time to complete the SSE handshake on cold starts and slow environments
// without falsely cycling into "reconnecting" during normal operation.
const OPEN_TIMEOUT_MS = 20_000;

// How many failed SSE attempts before we query the HTTP health endpoint.
// 8 attempts × up to 15 s each = up to ~120 s — covers Render cold starts.
const OFFLINE_THRESHOLD_ATTEMPTS = 8;

// Watchdog poll cadence — checks for zombie sockets.
const WATCHDOG_INTERVAL_MS = 10_000;

// Independent HTTP health-check cadence.
// Runs at all times; triggers an SSE reconnect when the API recovers.
// 8 s is a safe ceiling: well below Render's 30-s idle-proxy timeout,
// and at most ~7 req/min per admin tab — comfortably within the
// /broadcast-v2/health rate limit of 30 req/min.
const HEALTH_CHECK_INTERVAL_MS = 8_000;

// SSE-token fetch timeout. 15 s gives cold-start APIs enough time to
// respond before we give up and schedule the next backoff attempt.
const SSE_TOKEN_FETCH_TIMEOUT_MS = 15_000;

// ── Event catalogue ───────────────────────────────────────────────────────────
const KNOWN_EVENTS = [
  "snapshot", "viewer-count", "status", "broadcast-current-updated",
  "broadcast-queue-updated", "broadcast-schedule-updated", "broadcast-control-updated",
  "override-expired", "heartbeat", "stream-health", "live-failure-stats",
  "videos-library-updated", "transcoding-update", "live-ingest-health",
  "live-ingest-recovered", "live-ingest-failover", "live-ingest-promoted",
  "live-ingest-stopped", "ops-alert-sent", "yt-status", "live-reaction",
  "youtube-quota-throttled", "youtube-quota-exhausted", "prayer-received",
  "prayer-updated", "prayer-deleted", "chat-message", "emergency-broadcast",
  "live-ingest-stream-started", "live-ingest-stream-stopped",
];

function summarize(event: string, data: unknown): string | null {
  if (event === "heartbeat" || event === "stream-health" || event === "viewer-count") return null;
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  switch (event) {
    case "snapshot": case "status": {
      const isLive = Boolean(d.isLive);
      const override = d.liveOverride as { title?: string } | null;
      const count = Number(d.deviceCount ?? 0);
      return isLive ? `On air — ${override?.title ?? d.ytTitle ?? "Live"} · ${count} viewers` : `Off air · ${count} idle`;
    }
    case "broadcast-control-updated": return "Broadcast control updated";
    case "broadcast-queue-updated": return "Queue updated";
    case "override-expired": return "Live override expired";
    case "transcoding-update": {
      const s = d.status as string;
      if (s === "hls_ready") return "Transcoding complete";
      if (s === "failed") return "Transcoding failed";
      if (s === "encoding") return "Transcoding started";
      return `Transcoding ${s}`;
    }
    case "videos-library-updated": return "Video library updated";
    case "prayer-received": return d.hasName ? "New prayer request" : "Anonymous prayer";
    case "youtube-quota-throttled": return "YouTube quota throttled";
    case "youtube-quota-exhausted": return "YouTube quota exhausted";
    default: return event;
  }
}

// ── SSE sub-token fetch ───────────────────────────────────────────────────────
//
// POST /admin/sse-token with Bearer token → short-lived single-use token.
// Extended timeout (15 s) handles Render free-tier cold starts (~30 s
// total across multiple retries). On 401 we attempt one silent token
// refresh before giving up.

async function fetchSseSubToken(): Promise<string> {
  const doFetch = async (): Promise<Response> => {
    const token = tokenStore.getAccess();
    const headers: Record<string, string> = { "X-Admin-CSRF": "1" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), SSE_TOKEN_FETCH_TIMEOUT_MS);
    try {
      return await fetch(`${apiBase()}/admin/sse-token`, {
        method: "POST",
        headers,
        credentials: "include",
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  let res = await doFetch();

  if (res.status === 401 && tokenStore.getRefresh()) {
    try {
      await forceRefreshToken();
      res = await doFetch();
    } catch {
      // Refresh failed — outer catch will schedule a reconnect.
    }
  }

  if (!res.ok) throw new Error(`sse-token ${res.status}`);
  const d = (await res.json()) as { token?: string };
  if (!d.token) throw new Error("sse-token missing token");
  return d.token;
}

// ── HTTP health check ─────────────────────────────────────────────────────────
//
// Probes the public /broadcast-v2/health endpoint (no auth required).
// Returns true if the API is reachable and responding with 2xx.
// Used to distinguish "SSE proxy failure" (→ degraded) from
// "API completely unreachable" (→ offline).

async function checkApiHealth(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 5_000);
    const res = await fetch(`${apiBase()}/broadcast-v2/health`, {
      signal: ac.signal,
      credentials: "omit",
      cache: "no-store",
    });
    clearTimeout(tid);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function SSEProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SSEConnectionState>("connecting");
  const [lastStatusPayload, setLastStatusPayload] = useState<AdminLiveStatus | null>(null);
  const [recentActivity, setRecentActivity] = useState<SSEActivityEntry[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectingGraceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  // Consecutive token-fetch 401 failures. After AUTH_FAIL_LIMIT consecutive
  // auth failures (meaning both access token and refresh token are invalid),
  // we clear session storage and redirect to login. Without this guard the
  // SSE provider retries forever on an exponential backoff loop, keeping an
  // invisible unauthenticated session alive rather than prompting re-login.
  const consecutiveAuthFailures = useRef(0);
  const AUTH_FAIL_LIMIT = 3;
  const listenersRef = useRef<Map<string, Set<SSEEventHandler>>>(new Map());
  const lastFrameAt = useRef<number>(Date.now());
  // Guards against concurrent connect() calls.
  const connecting = useRef(false);
  // Provider-mount guard — prevents socket leaks after unmount.
  const mounted = useRef(true);
  // Tracks whether we've ever successfully connected in this session.
  // Used to decide whether to allow reconnects while the tab is hidden.
  const everConnected = useRef(false);
  // Ref mirror of state for reading inside intervals / timeouts without
  // stale closure issues.
  const stateRef = useRef<SSEConnectionState>("connecting");

  const setStateSynced = useCallback((s: SSEConnectionState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const pushActivity = useCallback((event: string, data: unknown) => {
    const summary = summarize(event, data);
    if (!summary) return;
    setRecentActivity((prev) => {
      const entry: SSEActivityEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        event, ts: Date.now(), summary,
      };
      const next = [entry, ...prev];
      return next.length > ACTIVITY_BUFFER_SIZE ? next.slice(0, ACTIVITY_BUFFER_SIZE) : next;
    });
  }, []);

  const emit = useCallback((event: string, data: unknown) => {
    listenersRef.current.get(event)?.forEach((h) => h(data));
  }, []);

  // ── scheduleReconnect ───────────────────────────────────────────────────────
  //
  // Every failure path routes through here for uniform backoff.
  // Before transitioning to "offline" (after OFFLINE_THRESHOLD_ATTEMPTS),
  // we perform a lightweight HTTP health check:
  //   • API reachable → "degraded"  (SSE proxy issue, not a real outage)
  //   • API unreachable → "offline" (genuine connectivity loss)
  //
  // This prevents a false "Offline" badge when only the SSE channel is
  // broken (e.g. Render SSE proxy timeout, Replit dev proxy quirk).

  const scheduleReconnect = useCallback(() => {
    if (!mounted.current) return;

    if (reconnectingGraceTimer.current === null) {
      reconnectingGraceTimer.current = setTimeout(() => {
        reconnectingGraceTimer.current = null;
        if (!mounted.current || esRef.current) return;

        if (attempt.current >= OFFLINE_THRESHOLD_ATTEMPTS) {
          // Check whether the HTTP API is actually reachable before
          // surfacing the red "Offline" badge — prevents false positives
          // when only the SSE channel is unavailable.
          void checkApiHealth().then((reachable) => {
            if (!mounted.current || esRef.current) return;
            setStateSynced(reachable ? "degraded" : "offline");
          });
        } else if (everConnected.current || attempt.current >= RECONNECTING_AFTER_ATTEMPTS) {
          // Only show "reconnecting" once we've had a prior successful
          // connection, or after several failed attempts. On the very first
          // connect sequence (dev proxy warm-up), "connecting" is more
          // accurate than "reconnecting".
          setStateSynced("reconnecting");
        }
        // else: keep "connecting" state — initial warm-up phase
      }, RECONNECTING_GRACE_MS);
    }

    // Exponential backoff with jitter, capped at MAX_BACKOFF_MS.
    // The high cap lets us survive Render cold starts (~30 s) without
    // flooding the server during outages.
    const baseMs = Math.min(300 * 2 ** attempt.current, MAX_BACKOFF_MS);
    const jitterMs = baseMs * (0.75 + Math.random() * 0.5);
    attempt.current++;

    reconnectTimer.current = setTimeout(() => {
      if (!mounted.current) return;
      // Allow reconnect even when hidden if we've never successfully
      // connected (first-load scenario where tab opened in background).
      const hiddenAndConnectedBefore =
        document.visibilityState === "hidden" && everConnected.current;
      if (!hiddenAndConnectedBefore) connect();
    }, jitterMs);
  // `connect` is forward-referenced via the ref pattern — dep added below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStateSynced]);

  // ── connect ─────────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (connecting.current) return;
    connecting.current = true;

    esRef.current?.close();
    esRef.current = null;

    fetchSseSubToken()
      .then((sseToken) => {
        consecutiveAuthFailures.current = 0; // reset on success
        if (!mounted.current) return;

        const apiOrigin = apiBase();
        const url = new URL(
          `${apiOrigin}/admin/live/events?platform=admin`,
          window.location.origin,
        );
        url.searchParams.set("sseToken", sseToken);

        // Use full href for cross-origin connections (split-domain prod);
        // relative path for same-origin (dev Vite proxy) to avoid CORS
        // preflight complexity.
        const esUrl =
          url.origin !== window.location.origin
            ? url.href
            : url.pathname + url.search;

        const es = new EventSource(esUrl);
        esRef.current = es;
        lastFrameAt.current = Date.now();

        // Guard: if `open` never fires within OPEN_TIMEOUT_MS the Vite/nginx
        // dev proxy silently accepted the TCP connection but never forwarded
        // it to the API (common on first 1-2 attempts at startup). Close and
        // retry rather than letting it hang for up to 15 s.
        const openTimeout = setTimeout(() => {
          if (!mounted.current || esRef.current !== es) return;
          es.close();
          esRef.current = null;
          scheduleReconnect();
        }, OPEN_TIMEOUT_MS);

        es.addEventListener("open", () => {
          clearTimeout(openTimeout);
          // ── Stale-closure guard ────────────────────────────────────────────
          // A concurrent connect() call may have already closed this ES and
          // created a newer one. If so, this `open` belongs to a dead socket —
          // ignore it so we don't incorrectly flip state to "connected" for a
          // connection that no longer exists.
          if (esRef.current !== es) return;
          if (reconnectingGraceTimer.current !== null) {
            clearTimeout(reconnectingGraceTimer.current);
            reconnectingGraceTimer.current = null;
          }
          const wasAlreadyConnected = everConnected.current;
          everConnected.current = true;
          attempt.current = 0;
          lastFrameAt.current = Date.now();
          setStateSynced("connected");
          // On reconnect (not the very first connect), invalidate all query
          // caches immediately.  During a multi-minute SSE outage, library
          // data, broadcast state, and queue data may have diverged from what
          // the server now reports.  Invalidating here forces a background
          // refetch so the dashboard reflects real server state the moment
          // the connection is restored — without waiting for individual
          // staleTime windows to expire.
          if (wasAlreadyConnected) {
            queryClient.invalidateQueries();
          }
        });

        KNOWN_EVENTS.forEach((evt) => {
          es.addEventListener(evt, (e: MessageEvent) => {
            // Guard: discard frames from a replaced EventSource so stale events
            // don't advance lastFrameAt (which would suppress the watchdog) or
            // dispatch to subscribers.
            if (esRef.current !== es) return;
            lastFrameAt.current = Date.now();
            let parsed: unknown = e.data;
            try { parsed = JSON.parse(e.data as string); } catch { /* keep raw string */ }
            // Only update structured listeners when the payload is actually an
            // object. Malformed JSON leaves `parsed` as the raw string literal —
            // passing that to setLastStatusPayload (typed as AdminLiveStatus)
            // would cause "cannot read property 'isLive' of string"-style crashes
            // in any consumer that destructures the value without nullish checks.
            if (evt === "snapshot" || evt === "status") {
              if (typeof parsed === "object" && parsed !== null) {
                setLastStatusPayload(parsed as AdminLiveStatus);
              }
              // Don't propagate raw string payloads to status listeners —
              // they cannot safely consume a string where an object is expected.
              if (typeof parsed !== "object" || parsed === null) {
                pushActivity(evt, parsed);
                return; // skip emit to structured listeners
              }
            }
            pushActivity(evt, parsed);
            emit(evt, parsed);
          });
        });

        es.onerror = () => {
          clearTimeout(openTimeout);
          // ── Stale-closure guard (critical) ────────────────────────────────
          // When connect() explicitly closes an old EventSource to start a
          // fresh handshake, the old ES fires `onerror` asynchronously.
          // Without this guard the handler would:
          //   1. Set esRef.current = null  — nullifying the BRAND-NEW connection
          //   2. Call scheduleReconnect()  — firing a timer that closes the new
          //      connection before it opens, restarting the cycle
          // This creates a self-perpetuating storm: Connecting → Reconnecting
          // → Connecting → … that never settles on "Connected".
          // Fix: only act when this ES is still the authoritative connection.
          if (esRef.current !== es) return;
          es.close();
          esRef.current = null;
          scheduleReconnect();
        };
      })
      .catch((err: unknown) => {
        // Token fetch failed — could be 401 (expired session), network, or
        // timeout. Only 401s count toward the auth-failure limit because
        // network blips should never force a sign-out.
        if (err instanceof Error && err.message.includes("401")) {
          consecutiveAuthFailures.current++;
          if (consecutiveAuthFailures.current >= AUTH_FAIL_LIMIT) {
            // All token-refresh attempts failed — the session is truly dead.
            // Clear stored tokens and redirect to login so the user is
            // prompted to authenticate rather than looping indefinitely.
            tokenStore.clear();
            window.location.assign("/login");
          }
        }
      })
      .finally(() => {
        connecting.current = false;
        // If no EventSource was created, schedule next attempt.
        if (!esRef.current && mounted.current) scheduleReconnect();
      });
  }, [emit, pushActivity, scheduleReconnect, setStateSynced]);

  // ── Main effect — connect + event listeners + watchdog + health monitor ─────
  useEffect(() => {
    mounted.current = true;
    connect();

    // ── Visibility restore ──────────────────────────────────────────────────
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const stale = Date.now() - lastFrameAt.current > HEARTBEAT_STALE_MS;
      if (!esRef.current || stale) {
        clearTimeout(reconnectTimer.current);
        attempt.current = 0;
        connect();
      }
    };

    // ── Network recovery ────────────────────────────────────────────────────
    const onOnline = () => {
      clearTimeout(reconnectTimer.current);
      attempt.current = 0;
      // Immediately surface "reconnecting" so the pill transitions away
      // from red/amber before the handshake completes.
      if (stateRef.current === "offline" || stateRef.current === "degraded") {
        setStateSynced("reconnecting");
      }
      connect();
    };

    // ── Network loss ────────────────────────────────────────────────────────
    const onOffline = () => {
      if (!mounted.current) return;
      clearTimeout(reconnectTimer.current);
      if (reconnectingGraceTimer.current !== null) {
        clearTimeout(reconnectingGraceTimer.current);
        reconnectingGraceTimer.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
      setStateSynced("offline");
    };

    // ── Zombie watchdog ─────────────────────────────────────────────────────
    // Fires every 10 s. Catches silent TCP half-open sockets that the
    // browser never surfaces as an `error` event (e.g. LB idle timeout,
    // Cloudflare 100 s proxy timeout, Render SSE proxy drop).
    const watchdog = setInterval(() => {
      if (!mounted.current) return;
      if (document.visibilityState === "hidden") return;
      const stale = Date.now() - lastFrameAt.current > HEARTBEAT_STALE_MS;
      if (stale && !connecting.current) {
        clearTimeout(reconnectTimer.current);
        attempt.current = 0;
        connect();
      }
    }, WATCHDOG_INTERVAL_MS);

    // ── HTTP health monitor ─────────────────────────────────────────────────
    // Runs independently of SSE. When the API is reachable but SSE is
    // down (degraded/offline state), this triggers a fresh connect()
    // attempt so the panel recovers automatically — even after a long
    // outage — without the operator having to reload the page.
    const healthMonitor = setInterval(async () => {
      if (!mounted.current) return;
      // No need to probe when SSE is already live.
      if (esRef.current && stateRef.current === "connected") return;
      // Don't start a health check while a connect is already in progress.
      if (connecting.current) return;

      const reachable = await checkApiHealth();
      if (!mounted.current) return;

      if (reachable) {
        if (
          stateRef.current === "offline" ||
          stateRef.current === "degraded" ||
          stateRef.current === "reconnecting"
        ) {
          // API is up — attempt to (re)establish the SSE channel.
          clearTimeout(reconnectTimer.current);
          attempt.current = 0;
          connect();
        }
        // Correct a stale "offline" label that somehow persisted.
        if (stateRef.current === "offline" && !esRef.current) {
          setStateSynced("reconnecting");
        }
      } else {
        // Confirm offline if SSE is also down.
        if (!esRef.current && stateRef.current !== "offline") {
          setStateSynced("offline");
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      mounted.current = false;
      clearInterval(watchdog);
      clearInterval(healthMonitor);
      esRef.current?.close();
      esRef.current = null;
      clearTimeout(reconnectTimer.current);
      if (reconnectingGraceTimer.current !== null) {
        clearTimeout(reconnectingGraceTimer.current);
        reconnectingGraceTimer.current = null;
      }
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [connect, setStateSynced]);

  const subscribe = useCallback((event: string, handler: SSEEventHandler) => {
    if (!listenersRef.current.has(event)) listenersRef.current.set(event, new Set());
    listenersRef.current.get(event)!.add(handler);
    return () => listenersRef.current.get(event)?.delete(handler);
  }, []);

  // forceReconnect: immediately cancel any pending backoff and try to
  // (re)connect. Called from pages that have an independent signal that
  // the server is back up (e.g. the V2 broadcast WS reconnected).
  // No-ops when already connected or while a connect() is in flight so
  // the guard inside connect() keeps concurrent calls idempotent.
  const forceReconnect = useCallback(() => {
    if (!mounted.current) return;
    if (stateRef.current === "connected") return; // already live — no-op
    if (connecting.current) return;               // handshake in progress
    clearTimeout(reconnectTimer.current);
    attempt.current = 0;
    connect();
  }, [connect]);

  const value = useMemo(
    () => ({ state, subscribe, lastStatusPayload, recentActivity, forceReconnect }),
    [state, subscribe, lastStatusPayload, recentActivity, forceReconnect],
  );

  return <SSEContext.Provider value={value}>{children}</SSEContext.Provider>;
}

export function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error("useSSE must be used within SSEProvider");
  return ctx;
}

export function useSSEEvent(event: string, handler: SSEEventHandler) {
  const { subscribe } = useSSE();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(event, (d) => ref.current(d)), [subscribe, event]);
}

export function useRecentActivity() { return useSSE().recentActivity; }
