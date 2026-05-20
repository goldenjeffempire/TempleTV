import { useEffect, useState } from "react";

function getIsOnline() {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/**
 * ConnectivityBanner — surfaces two classes of connection failure to the viewer:
 *
 *   1. Device network offline (`navigator.onLine = false`) — red banner.
 *      The player cannot receive ANY data. Playback freezes.
 *
 *   2. Broadcast WebSocket disconnected (API server unreachable or restarting)
 *      — amber banner. The device is online but the sync channel is down.
 *      The player continues with its last-known state but cannot receive
 *      program transitions or failover signals until it reconnects.
 *      (F06 fix: detected via the `temple-tv-broadcast-connected` custom event
 *      dispatched by useBroadcastSync in @workspace/broadcast-sync whenever
 *      the WebSocket open/close state changes — no second connection needed.)
 */
export function ConnectivityBanner() {
  const [isOnline, setIsOnline] = useState(getIsOnline);
  const [broadcastConnected, setBroadcastConnected] = useState(true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // F06: listen for WS reconnect events dispatched by useBroadcastSync
    // so we can surface "Reconnecting to broadcast…" without opening a
    // second connection or requiring prop drilling through every page.
    const handleBroadcastConnected = (e: Event) => {
      const detail = (e as CustomEvent<{ connected: boolean }>).detail;
      setBroadcastConnected(detail.connected);
    };
    window.addEventListener("temple-tv-broadcast-connected", handleBroadcastConnected);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("temple-tv-broadcast-connected", handleBroadcastConnected);
    };
  }, []);

  if (!isOnline) {
    return (
      <div
        role="status"
        aria-live="assertive"
        className="fixed left-1/2 top-4 z-[10000] -translate-x-1/2 rounded-md border border-red-400/50 bg-red-950/90 px-4 py-2 text-sm font-medium text-red-100 shadow-lg"
      >
        Network disconnected. Playback and API updates may be delayed.
      </div>
    );
  }

  if (!broadcastConnected) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed left-1/2 top-4 z-[10000] -translate-x-1/2 rounded-md border border-amber-400/50 bg-amber-950/90 px-4 py-2 text-sm font-medium text-amber-100 shadow-lg"
      >
        Reconnecting to broadcast…
      </div>
    );
  }

  return null;
}
