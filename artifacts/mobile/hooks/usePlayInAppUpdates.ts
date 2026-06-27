/**
 * usePlayInAppUpdates — Temple TV
 *
 * Full lifecycle manager for Google Play In-App Updates (Android only).
 *
 * Behaviours:
 *   - On mount + app foreground: calls checkForUpdate() (throttled to CHECK_COOLDOWN_MS).
 *   - Resumes already-downloaded updates from a previous session (isAlreadyDownloaded).
 *   - Optional updates: shows FlexibleUpdateSheet; user can snooze per versionCode for 24 h.
 *   - Mandatory updates (server flag OR staleness ≥ MANDATORY_STALE_DAYS): auto-starts
 *     IMMEDIATE flow; falls back to FLEXIBLE when device only allows FLEXIBLE.
 *   - Download progress flows via native InstallStateUpdatedListener events.
 *   - Network failures: exponential-backoff retry (5 s / 15 s / 1 min / 5 min).
 *   - Battery-efficient: AppState listener + cooldown prevents redundant polls.
 *   - Safe no-op on iOS, web, and non-Play builds.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  type InstallStateEvent,
  type InstallStatus,
  checkForUpdate,
  completeUpdate,
  isInAppUpdatesSupported,
  onInstallStateUpdate,
  startUpdate,
  UpdateType,
} from "expo-in-app-updates";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SNOOZE_KEY           = "@temple_tv/play_update_snoozed_vc";
const SNOOZE_DURATION_MS   = 24 * 60 * 60 * 1000;   // 24 h per version
const MANDATORY_STALE_DAYS = 5;                       // ≥5 stale days → mandatory
const CHECK_COOLDOWN_MS    = 30 * 60 * 1000;         // 30 min between polls
const RETRY_DELAYS_MS      = [5_000, 15_000, 60_000, 300_000];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayUpdateState {
  isChecking:    boolean;
  isAvailable:   boolean;
  isDownloading: boolean;
  isDownloaded:  boolean;
  isMandatory:   boolean;
  progress:      number;
  versionCode:   number | null;
  status:        InstallStatus | "idle" | "cancelled";
  error:         string | null;
  sheetVisible:  boolean;
}

export interface PlayUpdateActions {
  startFlexibleUpdate:   () => Promise<void>;
  startImmediateUpdate:  () => Promise<void>;
  restartForUpdate:      () => Promise<void>;
  retryDownload:         () => Promise<void>;
  dismissSheet:          () => void;
  checkNow:              () => Promise<void>;
}

const INITIAL_STATE: PlayUpdateState = {
  isChecking:    false,
  isAvailable:   false,
  isDownloading: false,
  isDownloaded:  false,
  isMandatory:   false,
  progress:      0,
  versionCode:   null,
  status:        "idle",
  error:         null,
  sheetVisible:  false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Snooze persistence
// ─────────────────────────────────────────────────────────────────────────────

async function getSnoozedVersionCode(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(SNOOZE_KEY);
    if (!raw) return null;
    const { vc, at } = JSON.parse(raw) as { vc: string; at: number };
    if (Date.now() - at > SNOOZE_DURATION_MS) {
      await AsyncStorage.removeItem(SNOOZE_KEY).catch(() => {});
      return null;
    }
    return vc;
  } catch { return null; }
}

async function snoozeVersionCode(vc: number): Promise<void> {
  try {
    await AsyncStorage.setItem(SNOOZE_KEY, JSON.stringify({ vc: String(vc), at: Date.now() }));
  } catch { /* non-critical */ }
}

async function clearSnooze(): Promise<void> {
  try { await AsyncStorage.removeItem(SNOOZE_KEY); } catch { /* non-critical */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param serverIsMandatory — pass true when the API version check marks this
 *   version as mandatory (isMandatory: true OR currentVersion < minRequired).
 */
export function usePlayInAppUpdates(
  serverIsMandatory = false,
): PlayUpdateState & PlayUpdateActions {

  const [state, setState] = useState<PlayUpdateState>(INITIAL_STATE);

  // ── Stable mutable refs ────────────────────────────────────────────────────
  const serverIsMandatoryRef = useRef(serverIsMandatory);
  useEffect(() => { serverIsMandatoryRef.current = serverIsMandatory; }, [serverIsMandatory]);

  const lastCheckRef      = useRef<number>(0);
  const checkInFlightRef  = useRef<boolean>(false);
  const retryCountRef     = useRef<number>(0);
  const retryTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef          = useRef<PlayUpdateState>(INITIAL_STATE);

  // ── setState helper — keeps stateRef in sync ─────────────────────────────

  const setPartial = useCallback((patch: Partial<PlayUpdateState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      stateRef.current = next;
      return next;
    });
  }, []);

  // ── Retry schedule ─────────────────────────────────────────────────────────
  // Note: scheduleRetry references runCheck via the ref below to avoid a
  // circular useCallback dependency.  The ref is populated after runCheck
  // is defined.

  const runCheckRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  const scheduleRetry = useCallback(() => {
    const count = retryCountRef.current;
    retryCountRef.current = count + 1;
    const delay = RETRY_DELAYS_MS[Math.min(count, RETRY_DELAYS_MS.length - 1)];
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => {
      lastCheckRef.current = 0;
      void runCheckRef.current(true);
    }, delay);
  }, []);

  // ── Core update check ──────────────────────────────────────────────────────

  const runCheck = useCallback(async (force = false) => {
    if (Platform.OS !== "android" || !isInAppUpdatesSupported()) return;
    if (checkInFlightRef.current) return;
    const now = Date.now();
    if (!force && now - lastCheckRef.current < CHECK_COOLDOWN_MS) return;
    lastCheckRef.current = now;
    checkInFlightRef.current = true;

    setPartial({ isChecking: true });

    try {
      const info = await checkForUpdate();
      if (!info) {
        setPartial({ isChecking: false });
        return;
      }

      // ── Resume a previously-downloaded update ────────────────────────────
      if (info.isAlreadyDownloaded) {
        retryCountRef.current = 0;
        setPartial({
          isChecking:   false,
          isAvailable:  true,
          isDownloaded: true,
          isMandatory:  serverIsMandatoryRef.current,
          status:       "downloaded",
          sheetVisible: true,
          versionCode:  info.availableVersionCode,
          error:        null,
        });
        return;
      }

      if (!info.isAvailable) {
        setPartial({ isChecking: false, isAvailable: false });
        return;
      }

      // ── Determine mandatory/optional ─────────────────────────────────────
      const staleDays      = info.staleDays ?? 0;
      const isMandatoryNow = serverIsMandatoryRef.current || staleDays >= MANDATORY_STALE_DAYS;

      // ── Snooze check (optional updates only) ──────────────────────────────
      if (!isMandatoryNow && info.availableVersionCode != null) {
        const snoozed = await getSnoozedVersionCode();
        if (snoozed === String(info.availableVersionCode)) {
          setPartial({ isChecking: false });
          return;
        }
      }

      retryCountRef.current = 0;
      setPartial({
        isChecking:   false,
        isAvailable:  true,
        isMandatory:  isMandatoryNow,
        versionCode:  info.availableVersionCode,
        sheetVisible: true,
        error:        null,
      });

      // ── Auto-start mandatory updates ─────────────────────────────────────
      if (isMandatoryNow) {
        if (info.allowsImmediate) {
          try { await startUpdate(UpdateType.IMMEDIATE); } catch { /* user may cancel */ }
        } else if (info.allowsFlexible) {
          try { await startUpdate(UpdateType.FLEXIBLE); } catch { /* handle via events */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Update check failed";
      setPartial({ isChecking: false, error: msg });
      scheduleRetry();
    } finally {
      checkInFlightRef.current = false;
    }
  }, [setPartial, scheduleRetry]);

  // Keep the ref current so scheduleRetry always calls the latest runCheck
  useEffect(() => { runCheckRef.current = runCheck; }, [runCheck]);

  // ── startFlexibleUpdate ────────────────────────────────────────────────────

  const startFlexibleUpdate = useCallback(async () => {
    if (Platform.OS !== "android" || !isInAppUpdatesSupported()) return;
    setPartial({ status: "pending", error: null, sheetVisible: true });
    try {
      const resultCode = await startUpdate(UpdateType.FLEXIBLE);
      // 0 = RESULT_OK (download started), -1 = RESULT_CANCELLED
      if (resultCode !== 0) {
        setPartial({ status: "cancelled", isDownloading: false, sheetVisible: false });
      }
    } catch (err) {
      setPartial({
        status:        "failed",
        isDownloading: false,
        error:         err instanceof Error ? err.message : "Download failed",
      });
      scheduleRetry();
    }
  }, [setPartial, scheduleRetry]);

  // ── startImmediateUpdate ───────────────────────────────────────────────────

  const startImmediateUpdate = useCallback(async () => {
    if (Platform.OS !== "android" || !isInAppUpdatesSupported()) return;
    try {
      await startUpdate(UpdateType.IMMEDIATE);
    } catch (err) {
      setPartial({ error: err instanceof Error ? err.message : "Update failed" });
    }
  }, [setPartial]);

  // ── restartForUpdate ───────────────────────────────────────────────────────

  const restartForUpdate = useCallback(async () => {
    if (Platform.OS !== "android" || !isInAppUpdatesSupported()) return;
    try {
      await completeUpdate();
    } catch (err) {
      setPartial({ error: err instanceof Error ? err.message : "Restart failed" });
    }
  }, [setPartial]);

  // ── retryDownload ──────────────────────────────────────────────────────────

  const retryDownload = useCallback(async () => {
    if (Platform.OS !== "android") return;
    setPartial({ status: "idle", error: null });
    lastCheckRef.current = 0;
    retryCountRef.current = 0;
    await runCheck(true);
  }, [setPartial, runCheck]);

  // ── dismissSheet ───────────────────────────────────────────────────────────

  const dismissSheet = useCallback(() => {
    const current = stateRef.current;
    if (current.isMandatory) return;
    const vc = current.versionCode;
    if (vc != null) void snoozeVersionCode(vc);
    setPartial({ sheetVisible: false });
  }, [setPartial]);

  // ── checkNow (public, bypasses cooldown) ─────────────────────────────────

  const checkNow = useCallback(async () => {
    lastCheckRef.current = 0;
    await runCheck(true);
  }, [runCheck]);

  // ── Install state listener ─────────────────────────────────────────────────

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const unsub = onInstallStateUpdate((event: InstallStateEvent) => {
      const isDownloading = event.status === "downloading";
      const isDownloaded  = event.status === "downloaded";
      const isFailed      = event.status === "failed";

      setPartial({
        status:        event.status,
        progress:      event.progress,
        isDownloading,
        isDownloaded,
        sheetVisible:  isDownloading || isDownloaded || isFailed,
        error:         isFailed
          ? "Download failed. Check your connection and try again."
          : null,
      });

      if (isDownloaded) {
        void clearSnooze();
      }
    });

    return unsub;
  }, [setPartial]);

  // ── Auto-apply mandatory downloaded updates ────────────────────────────────

  useEffect(() => {
    if (state.isDownloaded && state.isMandatory) {
      void restartForUpdate();
    }
  }, [state.isDownloaded, state.isMandatory, restartForUpdate]);

  // ── App foreground listener + initial check ───────────────────────────────

  useEffect(() => {
    if (Platform.OS !== "android") return;

    void runCheck();

    const sub = AppState.addEventListener("change", (status: AppStateStatus) => {
      if (status === "active") void runCheck();
    });

    return () => {
      sub.remove();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [runCheck]);

  return {
    ...state,
    startFlexibleUpdate,
    startImmediateUpdate,
    restartForUpdate,
    retryDownload,
    dismissSheet,
    checkNow,
  };
}
