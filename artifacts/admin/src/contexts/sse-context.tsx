import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { tokenStore, forceRefreshToken } from "@/lib/api";
import { apiBase } from "@/lib/api-base";

export type SSEConnectionState = "connecting" | "connected" | "reconnecting" | "offline";
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
}

const SSEContext = createContext<SSEContextValue | null>(null);

const MAX_BACKOFF_MS = 6_000;
const ACTIVITY_BUFFER_SIZE = 30;
// If we haven't received any named SSE event (including the server's
// `heartbeat` events emitted every 10 s) for this long, the socket is
// considered "zombie" — open at the TCP layer but silent.
//
// 30 s = 3 missed heartbeats (server sends every 10 s).  This gives a
// comfortable 3× safety margin above the heartbeat interval, surviving
// aggressive background-tab timer throttling (Chrome min ≈ 1 min when
// visible; can fire 2–4× late under memory pressure) without triggering
// false reconnects on idle-but-healthy streams.
//
// NOTE: The server MUST send a named `heartbeat` event (not a bare
// `: ping` comment).  SSE comments are discarded by EventSource and
// never reach any addEventListener callback, so they cannot update
// lastFrameAt.  The server heartbeat in admin-ops.routes.ts and
// realtime/sse.gateway.ts sends `event: heartbeat\ndata: {...}\n\n`.
const HEARTBEAT_STALE_MS = 30_000;
// How long to wait before surfacing the "reconnecting" state to UI.
// If the SSE connection recovers within this window (common after a
// brief server hiccup or tab re-focus) the spinner never shows at all.
const RECONNECTING_GRACE_MS = 1_500;
// After this many failed reconnect attempts (~11 s cumulative) we surface
// the "offline" state so operators know dashboard data is stale.
// The browser's `offline` event also triggers an immediate transition.
const OFFLINE_THRESHOLD_ATTEMPTS = 5;

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

// Fail-fast on any non-OK / network / timeout error so the caller can route
// the failure through its single jittered backoff path. Hung fetches must
// not be allowed to stall the connect() lock indefinitely — 8s is well
// above any healthy round-trip and well below typical user patience.
//
// On a 401 we attempt one silent token refresh (via the same rotation path
// used by the API wrapper) before giving up.  This handles the common case
// where the access token expired between the last keep-alive tick and the
// SSE reconnect — without this, every reconnect after token expiry would
// silently fail and eventually surface the "Offline" indicator even though
// the session is still alive and the refresh token is valid.
async function fetchSseSubToken(): Promise<string> {
  const doFetch = async (): Promise<Response> => {
    const token = tokenStore.getAccess();
    const headers: Record<string, string> = { "X-Admin-CSRF": "1" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 8_000);
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

  // On a 401, try once to silently refresh the access token then retry.
  // A 401 here means the access token expired between the last proactive
  // keep-alive and this reconnect attempt — forceRefreshToken() uses the
  // refresh token to issue a new access token without clearing the session.
  if (res.status === 401 && tokenStore.getRefresh()) {
    try {
      await forceRefreshToken();
      res = await doFetch();
    } catch {
      // Refresh failed — fall through, the outer catch/finally will
      // schedule a reconnect and the 401 error will eventually trigger
      // ttv:auth-expired through the normal auth-layer path.
    }
  }

  if (!res.ok) throw new Error(`sse-token ${res.status}`);
  const d = (await res.json()) as { token?: string };
  if (!d.token) throw new Error("sse-token missing token");
  return d.token;
}

export function SSEProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SSEConnectionState>("connecting");
  const [lastStatusPayload, setLastStatusPayload] = useState<AdminLiveStatus | null>(null);
  const [recentActivity, setRecentActivity] = useState<SSEActivityEntry[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Grace timer: delays surfacing "reconnecting" state so brief drops
  // (token refresh, server restart) don't flash the spinner in the UI.
  const reconnectingGraceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const listenersRef = useRef<Map<string, Set<SSEEventHandler>>>(new Map());
  // Tracks the last time *any* frame was received on the live SSE socket.
  // Used by the visibility-change handler and the continuous watchdog to
  // detect zombie connections.
  const lastFrameAt = useRef<number>(Date.now());
  // Guards against concurrent connect() invocations (e.g. visibility +
  // backoff timer racing) that would otherwise create two EventSources.
  const connecting = useRef(false);
  // Provider-mount flag — guards against the "EventSource created after
  // unmount because the in-flight token fetch resolved late" race that
  // would otherwise leak a socket past component teardown.
  const mounted = useRef(true);

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

  // Single backoff scheduler — every failure path (connect error, token
  // fetch error, late-resolve abort) routes through here so retry behavior
  // is uniform and the operator can reason about timing.
  const scheduleReconnect = useCallback(() => {
    if (!mounted.current) return;
    // Delay surfacing the "reconnecting"/"offline" state by RECONNECTING_GRACE_MS.
    // If the connection recovers within that window (e.g. token refresh,
    // transient server hiccup, tab wake-up) the spinner never shows.
    if (reconnectingGraceTimer.current === null) {
      reconnectingGraceTimer.current = setTimeout(() => {
        reconnectingGraceTimer.current = null;
        if (mounted.current && !esRef.current) {
          // Surface "offline" after enough failed attempts so operators know
          // dashboard data may be stale; otherwise show "reconnecting".
          setState(attempt.current >= OFFLINE_THRESHOLD_ATTEMPTS ? "offline" : "reconnecting");
        }
      }, RECONNECTING_GRACE_MS);
    }
    const baseMs = Math.min(300 * 2 ** attempt.current, MAX_BACKOFF_MS);
    const jitterMs = baseMs * (0.75 + Math.random() * 0.5);
    attempt.current++;
    reconnectTimer.current = setTimeout(() => {
      if (mounted.current && document.visibilityState !== "hidden") connect();
    }, jitterMs);
  // `connect` is forward-referenced; useCallback dep array is set after
  // both are declared via the ref pattern below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(() => {
    // Prevent the classic "two EventSources on one provider" bug: visibility
    // change + backoff timer can fire in the same tick, both call connect(),
    // both await the SSE-token fetch, and both end up assigning to esRef.
    if (connecting.current) return;
    connecting.current = true;

    esRef.current?.close();
    esRef.current = null;

    fetchSseSubToken().then((sseToken) => {
      // Late-resolve guard: the provider could have unmounted (or been
      // torn down by a logout flow) while the token fetch was in flight.
      // Creating an EventSource here would leak past the cleanup effect.
      if (!mounted.current) return;

      const apiOrigin = apiBase();
      const url = new URL(`${apiOrigin}/admin/live/events?platform=admin`, window.location.origin);
      // Sub-token only — we deliberately do NOT fall back to the raw
      // access token in the URL. EventSource cannot send Authorization
      // headers, so the only safe handoff is the short-lived sub-token
      // returned by the /admin/sse-token endpoint (which uses cookie or
      // bearer auth). Leaking an access token in the URL would hit
      // browser history, server access logs, and Referer headers.
      url.searchParams.set("sseToken", sseToken);

      // Use the full href for cross-origin connections (split-domain production:
      // admin.templetv.org.ng → api.templetv.org.ng, or separate Render services).
      // For same-origin connections the relative path is sufficient and avoids
      // any CORS preflight complexity. Without this, a cross-origin apiBase() would
      // have its origin silently stripped, causing EventSource to always connect to
      // the admin static-site host rather than the API — producing an immediate error
      // (HTML response, not text/event-stream) and an infinite "Reconnecting" loop.
      const esUrl =
        url.origin !== window.location.origin
          ? url.href
          : url.pathname + url.search;
      const es = new EventSource(esUrl);
      esRef.current = es;
      lastFrameAt.current = Date.now();

      es.addEventListener("open", () => {
        // Cancel the pending "reconnecting" grace timer — we're back up.
        if (reconnectingGraceTimer.current !== null) {
          clearTimeout(reconnectingGraceTimer.current);
          reconnectingGraceTimer.current = null;
        }
        setState("connected");
        attempt.current = 0;
        lastFrameAt.current = Date.now();
      });

      KNOWN_EVENTS.forEach((evt) => {
        es.addEventListener(evt, (e: MessageEvent) => {
          lastFrameAt.current = Date.now();
          let parsed: unknown = e.data;
          try { parsed = JSON.parse(e.data as string); } catch { /* keep raw */ }
          if (evt === "snapshot" || evt === "status") setLastStatusPayload(parsed as AdminLiveStatus);
          pushActivity(evt, parsed);
          emit(evt, parsed);
        });
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        scheduleReconnect();
      };
    }).catch(() => {
      // Token fetch failed (timeout, 401, network) — uniform backoff.
      // The next retry will re-fetch the token, giving a refreshed
      // session a chance to take effect.
    }).finally(() => {
      // Always release the lock — without `finally`, a hung-then-aborted
      // fetch would keep the lock set forever and block all future
      // visibility/online/timer-driven reconnects.
      connecting.current = false;
      // If we landed in catch (no esRef created), schedule next attempt.
      if (!esRef.current && mounted.current) scheduleReconnect();
    });
  }, [emit, pushActivity, scheduleReconnect]);

  useEffect(() => {
    mounted.current = true;
    connect();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const stale = Date.now() - lastFrameAt.current > HEARTBEAT_STALE_MS;
      // Force a fresh handshake on (a) socket-was-closed, or (b) socket
      // is open but no frame seen in HEARTBEAT_STALE_MS — the latter is
      // the "tab woken from sleep on a half-open TCP" case the browser
      // never surfaces as an `error`.
      if (!esRef.current || stale) {
        clearTimeout(reconnectTimer.current);
        attempt.current = 0;
        connect();
      }
    };

    const onOnline = () => {
      clearTimeout(reconnectTimer.current);
      attempt.current = 0;
      // If we were fully offline, surface "reconnecting" immediately so the
      // sidebar pill transitions away from red before the handshake completes.
      setState((s) => s === "offline" ? "reconnecting" : s);
      connect();
    };

    // Browser network-offline event → immediate transition to "offline" so
    // operators see the red pill right away without waiting for backoff.
    const onOffline = () => {
      if (!mounted.current) return;
      clearTimeout(reconnectTimer.current);
      if (reconnectingGraceTimer.current !== null) {
        clearTimeout(reconnectingGraceTimer.current);
        reconnectingGraceTimer.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
      setState("offline");
    };

    // Continuous zombie watchdog — fires every 10 s regardless of whether
    // a visibility change occurred. Catches the case where the tab stays
    // visible but the server-side SSE connection silently dies (e.g.
    // load-balancer idle timeout, Cloudflare 100 s proxy timeout).
    // The server heartbeats every 10 s, so HEARTBEAT_STALE_MS (15 s)
    // fires on the second missed heartbeat — well before any visible lag.
    const watchdog = setInterval(() => {
      if (!mounted.current) return;
      if (document.visibilityState === "hidden") return;
      const stale = Date.now() - lastFrameAt.current > HEARTBEAT_STALE_MS;
      if (stale && !connecting.current) {
        clearTimeout(reconnectTimer.current);
        attempt.current = 0;
        connect();
      }
    }, 10_000);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      mounted.current = false;
      clearInterval(watchdog);
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
  }, [connect]);

  const subscribe = useCallback((event: string, handler: SSEEventHandler) => {
    if (!listenersRef.current.has(event)) listenersRef.current.set(event, new Set());
    listenersRef.current.get(event)!.add(handler);
    return () => listenersRef.current.get(event)?.delete(handler);
  }, []);

  const value = useMemo(
    () => ({ state, subscribe, lastStatusPayload, recentActivity }),
    [state, subscribe, lastStatusPayload, recentActivity],
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
