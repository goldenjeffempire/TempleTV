import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

    const knownEvents = [
      "status",
      "broadcast-current-updated",
      "broadcast-queue-updated",
      "broadcast-control-updated",
      "override-expired",
      "heartbeat",
      "stream-health",
      "live-failure-stats",
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

  return (
    <SSEContext.Provider value={{ state, subscribe, lastStatusPayload, recentActivity }}>
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
