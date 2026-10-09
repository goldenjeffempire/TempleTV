import { AppState, type AppStateStatus } from "react-native";
import { useCallback, useEffect, useRef } from "react";
import { getApiBase } from "@/lib/apiBase";
import { secureStorage } from "@/lib/secureStorage";
import {
  issueViewerCredential,
  leaveViewerSession,
  sendViewerHeartbeat,
  type ViewerSession,
} from "@/lib/viewerTrackingApi";

const HEARTBEAT_MS = 10_000;
const MAX_RETRY_MS = 60_000;
const storedCredentialKey = () => `viewer_presence_${getApiBase().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
let credentialQueue: Promise<unknown> = Promise.resolve();
let installationSession: ViewerSession | null = null;
let installationApiBase: string | undefined;
export function invalidateInstallationSession(sessionId: string) {
  if (installationSession?.sessionId === sessionId) installationSession = null;
}
const activeOwners = new Set<symbol>();
export function acquireInstallationSession(token?: string): Promise<ViewerSession> {
  // Serialize overlapping hero/fullscreen mounts; both must use the same
  // installation capability even on first launch before storage is populated.
  const next = credentialQueue.catch(() => {}).then(async () => {
    // Capabilities identify installations, not accounts. Sharing the credential
    // avoids a second issuer call for foreground tracking/hero/fullscreen.
    if (installationSession && installationApiBase === getApiBase()) return installationSession;
    const resume = await secureStorage.getItem(storedCredentialKey());
    const session = await issueViewerCredential(getApiBase(), token, resume ?? undefined);
    await secureStorage.setItem(storedCredentialKey(), session.sessionId);
    installationSession = session;
    installationApiBase = getApiBase();
    return session;
  });
  credentialQueue = next;
  return next;
}

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
  const ownerRef = useRef(Symbol("live-player"));
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
  const wakeRequestedRef = useRef(false);
  const identityRef = useRef(token);
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
    activeOwners.delete(ownerRef.current);
    // Hero/fullscreen transitions can overlap. Leaving one mounted surface
    // must not withdraw the installation lease used by another active player.
    if (activeOwners.size > 0) return;
    if (session) await leaveViewerSession(getApiBase(), session);
  }, [clearTimers]);

  const issue = useCallback(async (): Promise<ViewerSession | null> => {
    if (!mountedRef.current || !enabledRef.current || !watchingRef.current ||
        appStateRef.current !== "active") return null;
    if (sessionRef.current) return sessionRef.current;
    if (issueRef.current) return issueRef.current;
    const generation = generationRef.current;
    const pending = acquireInstallationSession(tokenRef.current ?? undefined).then((session) => {
      if (!mountedRef.current || generation !== generationRef.current ||
           !enabledRef.current || !watchingRef.current || appStateRef.current !== "active") return null;
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
    if (heartbeatBusyRef.current) { wakeRequestedRef.current = true; return; }
    if (!mountedRef.current || !enabledRef.current || !watchingRef.current ||
        appStateRef.current !== "active") return;
    activeOwners.add(ownerRef.current);
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
        // Background/pause/unmount may have removed the session while this
        // request was pending. Remove any late server registration as well.
        if (sessionRef.current !== session || !mountedRef.current ||
            !enabledRef.current || !watchingRef.current ||
            appStateRef.current !== "active") {
          if (activeOwners.size === 0) await leaveViewerSession(getApiBase(), session);
          return;
        }
        if (response.status === 401) {
          invalidateInstallationSession(session.sessionId);
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
      if (wakeRequestedRef.current) {
        wakeRequestedRef.current = false;
        if (mountedRef.current && enabledRef.current && watchingRef.current && appStateRef.current === "active") {
          void heartbeatRef.current();
        }
      }
    }
  }, [clearTimers, issue]);

  heartbeatRef.current = heartbeat;

  useEffect(() => {
    const identityChanged = identityRef.current !== token;
    identityRef.current = token;
    if (identityChanged) {
      void leave().then(() => heartbeatRef.current());
    } else {
      // Transport reconnects must not withdraw a still-playing HTTP lease.
      void heartbeatRef.current();
    }
    return clearTimers;
  }, [enabled, activelyWatching, reconnectKey, token, clearTimers, leave]); // intentional: foreground/play/reconnect resumes

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