import { useEffect, useState } from "react";
import { Platform } from "react-native";

const PING_ENDPOINTS = [
  "https://api.templetv.org.ng/api/healthz",
  "https://1.1.1.1/cdn-cgi/trace",
  "https://connectivity-check.ubuntu.com",
];

async function checkConnectivity(): Promise<boolean> {
  for (const url of PING_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(4000),
        cache: "no-store",
      });
      if (res.ok || res.status < 500) return true;
    } catch {
    }
  }
  return false;
}

export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    if (Platform.OS === "web") {
      const handleOnline = () => setIsOnline(true);
      const handleOffline = () => setIsOnline(false);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      setIsOnline(navigator.onLine);
      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }

    let cancelled = false;

    const check = async () => {
      const online = await checkConnectivity();
      if (!cancelled) setIsOnline(online);
    };

    check();
    const interval = setInterval(check, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { isOnline };
}
