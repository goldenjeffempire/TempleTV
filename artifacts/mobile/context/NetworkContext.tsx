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
import { scheduleHeartbeat } from "@/lib/heartbeatScheduler";

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

interface ConnectivityResult {
  online: boolean;
  /** True when internet is up but only the app API probe failed. */
  apiUnreachable: boolean;
}

async function probeEndpoint(url: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(
      url,
      {
        method: "HEAD",
        signal: AbortSignal.timeout(4_000),
        cache: "no-store",
      },
      { maxRetries: 0 },
    );
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function checkConnectivity(): Promise<ConnectivityResult> {
  const base = getApiBase();
  const appHealthzUrl = base ? `${base}/api/healthz` : null;

  // Check internet via fallback endpoints (Cloudflare + Ubuntu).
  // Run in parallel for speed since fallbacks are independent.
  const fallbackResults = await Promise.all(PING_FALLBACKS.map(probeEndpoint));
  const internetUp = fallbackResults.some(Boolean);

  if (!internetUp) {
    // All probes failed — no internet.
    return { online: false, apiUnreachable: false };
  }

  // Internet is up. Now check the app API specifically.
  if (appHealthzUrl) {
    const apiOk = await probeEndpoint(appHealthzUrl);
    if (!apiOk) {
      // Internet works but app API is unreachable.
      return { online: false, apiUnreachable: true };
    }
  }

  return { online: true, apiUnreachable: false };
}

// ── Context ───────────────────────────────────────────────────────────────────

interface NetworkState {
  isOnline: boolean;
  justRecovered: boolean;
  /**
   * When isOnline is false:
   *   null  — haven't determined whether the API is the culprit yet
   *   true  — internet is up but the app's API is unreachable specifically
   *   false — no internet (all endpoints unreachable)
   */
  apiUnreachable: boolean | null;
}

const NetworkContext = createContext<NetworkState>({
  isOnline: true,
  justRecovered: false,
  apiUnreachable: null,
});

export function useNetworkContext(): NetworkState {
  return useContext(NetworkContext);
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [justRecovered, setJustRecovered] = useState(false);
  const [apiUnreachable, setApiUnreachable] = useState<boolean | null>(null);

  const prevOnlineRef       = useRef(true);
  const isOnlineRef         = useRef(true);
  const recoveryTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Offline fast-poll (8 s) — only active while the device is offline.
  // Cannot be merged into the shared heartbeat because 8 s is not a clean
  // multiple of the 15 s base tick. Kept as a private setInterval so offline
  // recovery is still detected within ~10 s.
  const offlineIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  // Online slow-poll (30 s = 2 × 15 s heartbeat ticks) — unsubscribe handle
  // for the shared HeartbeatScheduler. Null while the device is offline.
  const heartbeatUnsubRef   = useRef<(() => void) | null>(null);

  function applyStatus({ online, apiUnreachable: apiUnreachableFlag }: ConnectivityResult): void {
    const wasOffline = !prevOnlineRef.current;
    prevOnlineRef.current = online;
    isOnlineRef.current = online;
    setIsOnline(online);
    setApiUnreachable(online ? null : apiUnreachableFlag);

    if (online && wasOffline) {
      // Connection just came back — trigger the recovery flash.
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      setJustRecovered(true);
      recoveryTimerRef.current = setTimeout(() => {
        setJustRecovered(false);
      }, RECOVERY_FLASH_MS);
    }

    // Adaptive poll strategy:
    //   Online  → shared HeartbeatScheduler tick every 30 s (2 × 15 s base)
    //             Merges this timer with the player-core janitor so both run
    //             off a single JS interval — fewer iOS background timer wake-ups.
    //   Offline → private 8 s setInterval for fast recovery detection
    //             (8 s is not a multiple of 15 s so it stays independent)
    restartProbe(online ? POLL_ONLINE_MS : POLL_OFFLINE_MS);
  }

  function restartProbe(ms: number): void {
    // Clear both timer types first.
    if (offlineIntervalRef.current) {
      clearInterval(offlineIntervalRef.current);
      offlineIntervalRef.current = null;
    }
    heartbeatUnsubRef.current?.();
    heartbeatUnsubRef.current = null;

    const probe = (): void => {
      checkConnectivity()
        .then((online) => applyStatus(online))
        .catch(() => {});
    };

    if (ms >= POLL_ONLINE_MS) {
      // Online mode — join the shared 15 s heartbeat (fires every 2 ticks = 30 s).
      heartbeatUnsubRef.current = scheduleHeartbeat(probe, ms);
    } else {
      // Offline mode — aggressive private interval.
      offlineIntervalRef.current = setInterval(probe, ms);
    }
  }

  useEffect(() => {
    // ── Web: use native online/offline events ────────────────────────────
    if (Platform.OS === "web") {
      const handleOnline  = () => applyStatus({ online: true,  apiUnreachable: false });
      const handleOffline = () => applyStatus({ online: false, apiUnreachable: false });
      window.addEventListener("online",  handleOnline);
      window.addEventListener("offline", handleOffline);
      applyStatus({ online: navigator.onLine, apiUnreachable: false });
      return () => {
        window.removeEventListener("online",  handleOnline);
        window.removeEventListener("offline", handleOffline);
        if (offlineIntervalRef.current) clearInterval(offlineIntervalRef.current);
        heartbeatUnsubRef.current?.();
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
    // Start with the online rate (optimistic initial assumption).
    // Uses the shared heartbeat — no extra timer wake-up cost.
    restartProbe(POLL_ONLINE_MS);

    // When the app returns to the foreground, run an immediate probe instead
    // of waiting for the next scheduled poll tick. This covers the common
    // "locked phone → walk outside → return" scenario where connectivity may
    // have changed while the JS runtime was suspended.
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") runCheck();
    });

    return () => {
      cancelled = true;
      if (offlineIntervalRef.current) clearInterval(offlineIntervalRef.current);
      heartbeatUnsubRef.current?.();
      heartbeatUnsubRef.current = null;
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      appStateSub.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NetworkContext.Provider value={{ isOnline, justRecovered, apiUnreachable }}>
      {children}
    </NetworkContext.Provider>
  );
}
