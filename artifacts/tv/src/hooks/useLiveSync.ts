import { useEffect, useRef, useState } from "react";

export interface BroadcastSyncState {
  isLive: boolean;
  title: string | null;
  videoId: string | null;
  hlsStreamUrl: string | null;
  liveOverride: { id: string; title: string; hlsStreamUrl?: string | null } | null;
  syncedAt: string | null;
  serverTimeMs: number | null;
  connected: boolean;
}

const INITIAL: BroadcastSyncState = {
  isLive: false,
  title: null,
  videoId: null,
  hlsStreamUrl: null,
  liveOverride: null,
  syncedAt: null,
  serverTimeMs: null,
  connected: false,
};

function apiUrl(path: string): string {
  return `${window.location.origin}/api${path}`;
}

export function useLiveSync(): BroadcastSyncState {
  const [state, setState] = useState<BroadcastSyncState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(2000);

  useEffect(() => {
    let destroyed = false;

    const applyPayload = (current: Record<string, unknown>) => {
      const liveOverride = current.liveOverride as null | { id: string; title: string; hlsStreamUrl?: string | null };
      const item = current.item as null | { youtubeId?: string; title?: string };
      setState({
        isLive: !!liveOverride || !!item,
        title: liveOverride?.title ?? item?.title ?? null,
        videoId: item?.youtubeId ?? null,
        hlsStreamUrl: liveOverride?.hlsStreamUrl ?? null,
        liveOverride: liveOverride ?? null,
        syncedAt: (current.syncedAt as string) ?? null,
        serverTimeMs: (current.serverTimeMs as number) ?? null,
        connected: true,
      });
    };

    const fallbackPoll = async () => {
      if (destroyed) return;
      try {
        const res = await fetch(apiUrl("/broadcast/current"), { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error("poll failed");
        const data = await res.json() as Record<string, unknown>;
        if (!destroyed) applyPayload(data);
      } catch {}
      if (!destroyed) pollRef.current = setTimeout(fallbackPoll, 10_000);
    };

    const connect = () => {
      if (destroyed) return;
      try {
        const es = new EventSource(apiUrl("/broadcast/events"));
        esRef.current = es;

        es.addEventListener("broadcast-current-updated", (e: MessageEvent) => {
          if (destroyed) return;
          try {
            const { current } = JSON.parse(e.data) as { current: Record<string, unknown> };
            reconnectDelayRef.current = 2000;
            applyPayload(current);
          } catch {}
        });

        es.addEventListener("error", () => {
          es.close();
          esRef.current = null;
          if (!destroyed) {
            const delay = Math.min(reconnectDelayRef.current, 30_000);
            reconnectDelayRef.current = delay * 1.5;
            setTimeout(connect, delay);
          }
        });
      } catch {
        fallbackPoll();
      }
    };

    if (typeof EventSource !== "undefined") {
      connect();
    } else {
      fallbackPoll();
    }

    return () => {
      destroyed = true;
      esRef.current?.close();
      esRef.current = null;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  return state;
}
