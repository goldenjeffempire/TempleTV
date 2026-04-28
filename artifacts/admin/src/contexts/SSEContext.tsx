import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getAdminEventSourceUrl } from "@/lib/admin-access";

export type SSEConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

type SSEEventHandler = (data: unknown) => void;

export interface SSEActivityEntry {
  id: string;
  event: string;
  ts: number;
  summary: string;
}

interface SSEContextValue {
  state: SSEConnectionState;
  subscribe: (event: string, handler: SSEEventHandler) => () => void;
  lastStatusPayload: AdminLiveStatus | null;
  recentActivity: SSEActivityEntry[];
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

const SSEContext = createContext<SSEContextValue | null>(null);

const MAX_BACKOFF_MS = 30_000;

const ACTIVITY_BUFFER_SIZE = 25;

function summarizeEvent(event: string, data: unknown): string | null {
  if (event === "heartbeat") return null;
  // stream-health pings every second — never surface them in the activity feed
  // or the entire feed becomes a wall of duplicate entries.
  if (event === "stream-health") return null;
  const d = (data && typeof data === "object" ? (data as Record<string, unknown>) : {}) as Record<string, unknown>;
  switch (event) {
    case "status": {
      const isLive = Boolean(d.isLive);
      const override = d.liveOverride as { title?: string } | null | undefined;
      const ytTitle = (d.ytTitle as string | null | undefined) ?? undefined;
      const deviceCount = Number(d.deviceCount ?? 0);
      if (isLive) {
        const title = override?.title ?? ytTitle ?? "Live broadcast";
        return `On air — ${title} · ${deviceCount} viewers`;
      }
      return `Off air · ${deviceCount} viewers idle`;
    }
    case "broadcast-control-updated":
      return "Broadcast control updated";
    case "broadcast-queue-updated":
      return "Broadcast queue updated";
    case "override-expired":
      return "Live override expired";
    case "youtube-quota-throttled": {
      const context = (d.context as string | undefined) ?? "API";
      const pct = d.percentUsed != null ? `${Number(d.percentUsed)}%` : null;
      return pct
        ? `YouTube API throttled (${context}) — ${pct} of daily quota used`
        : `YouTube API throttled (${context})`;
    }
    case "youtube-quota-exhausted": {
      const context = (d.context as string | undefined) ?? "API";
      const reset = d.quotaResetAt as string | undefined;
      const when = reset ? new Date(reset).toLocaleTimeString() : "midnight PT";
      return `YouTube API quota exhausted (${context}) — resets ${when}`;
    }
    case "prayer-received":
      // Names and message bodies are intentionally omitted from the SSE
      // payload (defence-in-depth — see routes/broadcast.ts comment).
      // Activity feed shows a neutral arrival ping; operators get full
      // context when they open the Prayers page (the SSE handler
      // simultaneously invalidates the prayers query so it's already
      // fresh when they navigate).
      return d.hasName ? "New prayer request submitted" : "Anonymous prayer request submitted";
    case "prayer-updated":
      // Quiet to avoid flooding the activity feed when an operator
      // bulk-marks prayers read. The query invalidation still fires —
      // we just don't surface a per-row entry.
      return null;
    case "prayer-deleted":
      return null;
    default:
      return event;
  }
}

export function SSEProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SSEConnectionState>("connecting");
  const [lastStatusPayload, setLastStatusPayload] = useState<AdminLiveStatus | null>(null);
  const [recentActivity, setRecentActivity] = useState<SSEActivityEntry[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  const listenersRef = useRef<Map<string, Set<SSEEventHandler>>>(new Map());

  const pushActivity = useCallback((event: string, data: unknown) => {
    const summary = summarizeEvent(event, data);
    if (!summary) return;
    setRecentActivity((prev) => {
      const entry: SSEActivityEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        event,
        ts: Date.now(),
        summary,
      };
      const next = [entry, ...prev];
      return next.length > ACTIVITY_BUFFER_SIZE ? next.slice(0, ACTIVITY_BUFFER_SIZE) : next;
    });
  }, []);

  const emit = useCallback((event: string, data: unknown) => {
    const handlers = listenersRef.current.get(event);
    if (handlers) handlers.forEach((h) => h(data));
  }, []);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const url = getAdminEventSourceUrl("/api/admin/live/events?platform=admin");
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("open", () => {
      setState("connected");
      attempt.current = 0;
    });

    // ── Whitelist of SSE event types this context will dispatch ──────────────
    // EventSource only fires `addEventListener(type)` callbacks for events
    // whose `event:` field matches. Any event the server emits that isn't in
    // this list is silently dropped on the admin side — even if a page calls
    // `useSSEEvent("foo", ...)` for it. This used to silently break:
    //   - Live ingest health monitoring (live-ingest-* on /admin/streams)
    //   - Ops alert pulses (ops-alert-sent on /admin/dashboard)
    //   - Real-time content list refresh (videos-library-updated)
    //   - Schedule editor live sync (broadcast-schedule-updated)
    //   - In-flight transcode progress (transcoding-update)
    //   - Channel auto-detect status pings (yt-status)
    // Keep this list in sync with `broadcastLiveEvent(...)` callsites in
    // artifacts/api-server/src — when adding a new server event type that the
    // admin needs to react to, add it here too.
    const knownEvents = [
      "status",
      "broadcast-current-updated",
      "broadcast-queue-updated",
      "broadcast-schedule-updated",
      "broadcast-control-updated",
      "override-expired",
      "heartbeat",
      "stream-health",
      "live-failure-stats",
      // Video library mutation pings — let any admin list/grid that wants
      // to mirror the public site's live-update behaviour subscribe and
      // refetch on the same signal the TV/mobile clients use.
      "videos-library-updated",
      // Per-job transcoding progress pulses (transcoder.ts) — used by the
      // upload/encoding panels to drive real-time progress bars without
      // polling.
      "transcoding-update",
      // Live ingest pipeline state — admin's stream-health surfaces consume
      // these via useSSEEvent. Were previously silently dropped because the
      // event names weren't in this list.
      "live-ingest-health",
      "live-ingest-recovered",
      "live-ingest-failover",
      "live-ingest-promoted",
      "live-ingest-stopped",
      // Ops alert fan-out — driven by alerts.ts when a fatal log line or
      // cross-process incident fires. Admin dashboards subscribe to surface
      // a banner without re-polling /api/admin/alerts.
      "ops-alert-sent",
      // YouTube channel auto-detect status (yt poller). Worth carrying so
      // the live-monitor + dashboard can show the ytLive/ytVideoId state
      // without a second EventSource.
      "yt-status",
      // Live audience reaction pulses (broadcast.ts /reactions). Admin
      // engagement panels can subscribe to render real-time reaction counts.
      "live-reaction",
      // YouTube quota signals — emitted by routes/youtube.ts when the
      // Data API hits its soft-throttle threshold or hard daily cap. Without
      // these listeners the events were dropped on the floor and operators
      // had no real-time visibility into quota pressure.
      "youtube-quota-throttled",
      "youtube-quota-exhausted",
      // Prayer request lifecycle — emitted by routes/broadcast.ts on insert
      // (`prayer-received`) and routes/admin.ts on read-state change
      // (`prayer-updated`) / delete (`prayer-deleted`). The Prayers page
      // subscribes to all three so a viewer's prayer arrival or another
      // operator's read/delete action propagates instantly across every
      // open admin tab without waiting for the safety-net poll.
      "prayer-received",
      "prayer-updated",
      "prayer-deleted",
    ];

    knownEvents.forEach((evt) => {
      es.addEventListener(evt, (e: MessageEvent) => {
        let parsed: unknown = e.data;
        try { parsed = JSON.parse(e.data); } catch {}
        if (evt === "status") setLastStatusPayload(parsed as AdminLiveStatus);
        pushActivity(evt, parsed);
        emit(evt, parsed);
      });
    });

    es.onerror = () => {
      setState("reconnecting");
      es.close();
      esRef.current = null;
      const backoff = Math.min(1000 * Math.pow(2, attempt.current), MAX_BACKOFF_MS);
      attempt.current++;
      reconnectTimer.current = setTimeout(() => {
        if (document.visibilityState !== "hidden") connect();
      }, backoff);
    };
  }, [emit]);

  useEffect(() => {
    connect();

    const onVisible = () => {
      if (document.visibilityState === "visible" && state !== "connected") {
        clearTimeout(reconnectTimer.current);
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      esRef.current?.close();
      clearTimeout(reconnectTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const subscribe = useCallback((event: string, handler: SSEEventHandler) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set());
    }
    listenersRef.current.get(event)!.add(handler);
    return () => {
      listenersRef.current.get(event)?.delete(handler);
    };
  }, []);

  // Memoise the context value so consumers only re-render when one of the
  // four fields actually changes identity. Without this, every state setter
  // call inside SSEProvider — heartbeats, status payloads, activity entries,
  // even the ref-based reconnect cycles — produced a brand-new object literal
  // and forced every `useSSE()` / `useSSEEvent()` consumer (live monitor,
  // operations, broadcast queue, dashboard, every header indicator) to
  // re-render. `subscribe` is already a stable useCallback ref, so the
  // dependency list is just the three pieces of state.
  const value = useMemo(
    () => ({ state, subscribe, lastStatusPayload, recentActivity }),
    [state, subscribe, lastStatusPayload, recentActivity],
  );

  return (
    <SSEContext.Provider value={value}>
      {children}
    </SSEContext.Provider>
  );
}

export function useRecentSSEEvents(): SSEActivityEntry[] {
  return useSSE().recentActivity;
}

export function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error("useSSE must be used within SSEProvider");
  return ctx;
}

export function useSSEEvent(event: string, handler: SSEEventHandler) {
  const { subscribe } = useSSE();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsubscribe = subscribe(event, (data) => handlerRef.current(data));
    return unsubscribe;
  }, [subscribe, event]);
}
