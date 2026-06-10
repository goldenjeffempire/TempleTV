/**
 * NetworkContext — app-wide singleton network status.
 *
 * A single polling interval handles connectivity checks for the whole app
 * instead of each screen creating its own. Consumers call `useNetworkStatus()`
 * (the hook in hooks/useNetworkStatus.ts) which reads from this context.
 *
 * Exposes:
 *   isOnline      — current connectivity state
 *   justRecovered — true for ~2.5 s after the connection comes back (drives
 *                   the green "Back online" flash in NetworkBanner)
 *
 * Adaptive polling:
 *   • Online  → poll every 30 s (battery-friendly)
 *   • Offline → poll every 8 s (detect recovery within ~10 s)
 *   • AppState foreground transition → immediate check (catches the most
 *     common case: user locks phone, walks away, returns with connectivity
 *     restored — the 30 s timer would delay recovery for up to 30 s without
 *     this nudge)
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import { fetchWithRetry } from "@/lib/fetchWithRetry";
import { getApiBase } from "@/lib/apiBase";

// ── Connectivity probe ────────────────────────────────────────────────────────

// Static fallback endpoints: Cloudflare IP (no DNS required) and Ubuntu
// connectivity check. These cover general internet reachability.
const PING_FALLBACKS = [
  "https://1.1.1.1/cdn-cgi/trace",
  "https://connectivity-check.ubuntu.com",
];

// Build the probe list at module initialisation time so getApiBase() is
// evaluated once (its result is static — env vars are baked at build time).
// The app's own API healthz is placed first so corporate VPN environments
// that block Cloudflare / Ubuntu still report online when the API is
// reachable; it also covers dev-mode builds using a local or Replit URL.
function buildPingEndpoints(): string[] {
  const base = getApiBase();
  const appHealthz = base ? `${base}/api/healthz` : null;
  return appHealthz ? [appHealthz, ...PING_FALLBACKS] : PING_FALLBACKS;
}

const PING_ENDPOINTS = buildPingEndpoints();

const POLL_ONLINE_MS  = 30_000;
const POLL_OFFLINE_MS =  8_000;
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

  const prevOnlineRef    = useRef(true);
  const isOnlineRef      = useRef(true);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  function applyStatus(online: boolean): void {
    const wasOffline = !prevOnlineRef.current;
    prevOnlineRef.current = online;
    isOnlineRef.current = online;
    setIsOnline(online);

    if (online && wasOffline) {
      // Connection just came back — trigger the recovery flash.
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      setJustRecovered(true);
      recoveryTimerRef.current = setTimeout(() => {
        setJustRecovered(false);
      }, RECOVERY_FLASH_MS);
    }

    // Adaptive poll rate: fast polling while offline so recovery is detected
    // quickly; slow polling while online to preserve battery.
    const newRate = online ? POLL_ONLINE_MS : POLL_OFFLINE_MS;
    restartInterval(newRate);
  }

  function restartInterval(ms: number): void {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      checkConnectivity()
        .then((online) => applyStatus(online))
        .catch(() => {});
    }, ms);
  }

  useEffect(() => {
    // ── Web: use native online/offline events ────────────────────────────
    if (Platform.OS === "web") {
      const handleOnline  = () => applyStatus(true);
      const handleOffline = () => applyStatus(false);
      window.addEventListener("online",  handleOnline);
      window.addEventListener("offline", handleOffline);
      applyStatus(navigator.onLine);
      return () => {
        window.removeEventListener("online",  handleOnline);
        window.removeEventListener("offline", handleOffline);
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      };
    }

    // ── Native: poll + AppState foreground nudge ─────────────────────────
    let cancelled = false;

    const runCheck = () => {
      checkConnectivity()
        .then((online) => { if (!cancelled) applyStatus(online); })
        .catch(() => {});
    };

    // Immediate check on mount
    runCheck();
    // Start interval at the online rate (optimistic initial assumption)
    restartInterval(POLL_ONLINE_MS);

    // When the app returns to the foreground, run an immediate probe instead
    // of waiting for the next scheduled poll tick. This covers the common
    // "locked phone → walk outside → return" scenario where connectivity may
    // have changed while the JS runtime was suspended.
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") runCheck();
    });

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      appStateSub.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NetworkContext.Provider value={{ isOnline, justRecovered }}>
      {children}
    </NetworkContext.Provider>
  );
}
