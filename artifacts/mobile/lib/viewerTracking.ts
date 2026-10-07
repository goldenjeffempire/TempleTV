import { AppState, type AppStateStatus } from "react-native";
import { useCallback, useEffect, useRef } from "react";
import { getApiBase } from "@/lib/apiBase";
import {
  issueViewerCredential,
  leaveViewerSession,
  sendViewerHeartbeat,
  type ViewerSession,
} from "@/lib/viewerTrackingApi";

const HEARTBEAT_MS = 10_000;
const MAX_RETRY_MS = 60_000;

/**
 * Tracks one live player only. The opaque server credential lives in a ref for
 * the lifetime of this hook and is cleared on pause/background/unmount.
 */
export function useMobileViewerPresence({
  enabled,
  activelyWatching,
  token,
  reconnectKey,
}: {
  enabled: boolean;
  activelyWatching: boolean;
  token?: string | null;
  reconnectKey?: unknown;
}) {
  const sessionRef = useRef<ViewerSession | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const issueRef = useRef<Promise<ViewerSession | null> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryMsRef = useRef(HEARTBEAT_MS);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const watchingRef = useRef(activelyWatching);
  const enabledRef = useRef(enabled);
  const tokenRef = useRef(token);
  const heartbeatRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const heartbeatBusyRef = useRef(false);
  const reconnectRef = useRef(reconnectKey);
  watchingRef.current = activelyWatching;
  enabledRef.current = enabled;
  tokenRef.current = token;

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    retryTimerRef.current = null;
    intervalRef.current = null;
  }, []);

  const leave = useCallback(async () => {
    clearTimers();
    const session = sessionRef.current;
    sessionRef.current = null;
    generationRef.current++;
    if (session) await leaveViewerSession(getApiBase(), session);
  }, [clearTimers]);

  const issue = useCallback(async (): Promise<ViewerSession | null> => {
    if (!mountedRef.current || !enabledRef.current || !watchingRef.current ||
        appStateRef.current !== "active") return null;
    if (sessionRef.current) return sessionRef.current;
    if (issueRef.current) return issueRef.current;
    const generation = generationRef.current;
    const pending = issueViewerCredential(
      getApiBase(),
      tokenRef.current ?? undefined,
    ).then((session) => {
      if (!mountedRef.current || generation !== generationRef.current ||
          !enabledRef.current || !watchingRef.current) return null;
      sessionRef.current = session;
      retryMsRef.current = HEARTBEAT_MS;
      return session;
    }).catch(() => null).finally(() => {
      issueRef.current = null;
    });
    issueRef.current = pending;
    return pending;
  }, []);

  const heartbeat = useCallback(async () => {
    if (heartbeatBusyRef.current) return;
    if (!mountedRef.current || !enabledRef.current || !watchingRef.current ||
        appStateRef.current !== "active") return;
    heartbeatBusyRef.current = true;
    try {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      const session = await issue();
      if (!session || !mountedRef.current) {
        if (mountedRef.current && enabledRef.current && watchingRef.current) {
          const delay = retryMsRef.current;
          retryMsRef.current = Math.min(MAX_RETRY_MS, delay * 2);
          retryTimerRef.current = setTimeout(() => { void heartbeatRef.current(); }, delay);
        }
        return;
      }
      try {
        const response = await sendViewerHeartbeat(getApiBase(), session);
        if (response.status === 401) {
          sessionRef.current = null;
          clearTimers();
          retryTimerRef.current = setTimeout(() => { void heartbeatRef.current(); }, HEARTBEAT_MS);
          return;
        }
        if (!response.ok) throw new Error(`heartbeat ${response.status}`);
        retryMsRef.current = HEARTBEAT_MS;
        if (!intervalRef.current) {
          intervalRef.current = setInterval(() => { void heartbeatRef.current(); }, HEARTBEAT_MS);
        }
      } catch {
        if (!mountedRef.current || sessionRef.current !== session) return;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        const delay = retryMsRef.current;
        retryMsRef.current = Math.min(MAX_RETRY_MS, delay * 2);
        retryTimerRef.current = setTimeout(() => { void heartbeatRef.current(); }, delay);
      }
    } finally {
      heartbeatBusyRef.current = false;
    }
  }, [clearTimers, issue]);

  heartbeatRef.current = heartbeat;

  useEffect(() => {
    const reconnecting = reconnectRef.current !== reconnectKey;
    reconnectRef.current = reconnectKey;
    if (reconnecting) {
      void leave().then(() => heartbeatRef.current());
    } else {
      void heartbeatRef.current();
    }
    return clearTimers;
  }, [enabled, activelyWatching, reconnectKey, clearTimers, leave]); // intentional: foreground/play/reconnect reissues

  useEffect(() => {
    mountedRef.current = true;
    const onState = (next: AppStateStatus) => {
      const wasActive = appStateRef.current === "active";
      appStateRef.current = next;
      if (next !== "active" && wasActive) void leave();
      else if (next === "active" && watchingRef.current && enabledRef.current) void heartbeatRef.current();
    };
    const sub = AppState.addEventListener("change", onState);
    return () => {
      mountedRef.current = false;
      sub.remove();
      void leave();
    };
  }, [leave]);

  useEffect(() => {
    if (!enabled || !activelyWatching) void leave();
  }, [enabled, activelyWatching, leave]);
}