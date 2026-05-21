/**
 * NetworkContext — app-wide singleton network status.
 *
 * A single polling interval handles connectivity checks for the whole app
 * instead of each screen creating its own. Consumers call `useNetworkStatus()`
 * (the hook in hooks/useNetworkStatus.ts) which reads from this context.
 *
 * Exposes:
 *   isOnline     — current connectivity state
 *   justRecovered — true for ~2 s after the connection comes back (drives the
 *                   green "Back online" flash in NetworkBanner)
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

// ── Connectivity probe ────────────────────────────────────────────────────────

const PING_ENDPOINTS = [
  "https://api.templetv.org.ng/api/healthz",
  "https://1.1.1.1/cdn-cgi/trace",
  "https://connectivity-check.ubuntu.com",
];

const POLL_INTERVAL_MS = 30_000;
const RECOVERY_FLASH_MS = 2_500;

async function checkConnectivity(): Promise<boolean> {
  for (const url of PING_ENDPOINTS) {
    try {
      const res = await fetchWithRetry(
        url,
        {
          method: "HEAD",
          signal: AbortSignal.timeout(4_000),
          cache: "no-store",
        },
        // Single attempt only — we don't want the ping itself to retry;
        // the next poll cycle will retry naturally.
        { maxRetries: 0 },
      );
      if (res.ok || res.status < 500) return true;
    } catch {
      // Try next endpoint
    }
  }
  return false;
}

// ── Context ───────────────────────────────────────────────────────────────────

interface NetworkState {
  isOnline: boolean;
  justRecovered: boolean;
}

const NetworkContext = createContext<NetworkState>({
  isOnline: true,
  justRecovered: false,
});

export function useNetworkContext(): NetworkState {
  return useContext(NetworkContext);
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [justRecovered, setJustRecovered] = useState(false);

  const prevOnlineRef = useRef(true);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyStatus(online: boolean) {
    const wasOffline = !prevOnlineRef.current;
    prevOnlineRef.current = online;
    setIsOnline(online);

    if (online && wasOffline) {
      // Connection just came back — trigger the recovery flash.
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      setJustRecovered(true);
      recoveryTimerRef.current = setTimeout(() => {
        setJustRecovered(false);
      }, RECOVERY_FLASH_MS);
    }
  }

  useEffect(() => {
    if (Platform.OS === "web") {
      const handleOnline = () => applyStatus(true);
      const handleOffline = () => applyStatus(false);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      applyStatus(navigator.onLine);
      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
        if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      };
    }

    let cancelled = false;

    const check = async () => {
      const online = await checkConnectivity();
      if (!cancelled) applyStatus(online);
    };

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NetworkContext.Provider value={{ isOnline, justRecovered }}>
      {children}
    </NetworkContext.Provider>
  );
}
