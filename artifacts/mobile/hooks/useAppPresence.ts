import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/context/AuthContext";
import { getApiBase } from "@/lib/apiBase";
import { acquireInstallationSession, invalidateInstallationSession } from "@/lib/viewerTracking";
import { sendAppPresence, type ViewerSession } from "@/lib/viewerTrackingApi";

/** One foreground lease at the app root; never creates a broadcast-viewing lease. */
export function useAppPresence() {
  const { token } = useAuth();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  useEffect(() => {
    let disposed = false;
    let foreground = AppState.currentState === "active";
    let session: ViewerSession | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let rerun = false;
    let retryMs = 10_000;

    const withdraw = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (session) void sendAppPresence(getApiBase(), session, false).catch(() => {});
    };
    const tick = async () => {
      if (disposed || !foreground) return;
      if (busy) { rerun = true; return; }
      busy = true;
      try {
        session ??= await acquireInstallationSession(tokenRef.current ?? undefined);
        if (disposed || !foreground) return;
        const response = await sendAppPresence(getApiBase(), session, true);
        if (response.status === 401) {
          invalidateInstallationSession(session.sessionId);
          session = null;
        }
        if (!response.ok) throw new Error("App presence unavailable");
        retryMs = 10_000;
      } catch {
        retryMs = Math.min(30_000, retryMs * 2);
      } finally {
        busy = false;
        if (!disposed && foreground) {
          if (timer) clearTimeout(timer);
          const delay = rerun ? 0 : retryMs;
          rerun = false;
          timer = setTimeout(() => { void tick(); }, delay);
        }
      }
    };
    const subscription = AppState.addEventListener("change", state => {
      foreground = state === "active";
      if (foreground) { retryMs = 10_000; void tick(); }
      else withdraw();
    });
    void tick();
    return () => {
      disposed = true;
      subscription.remove();
      withdraw();
    };
  }, []);
}
