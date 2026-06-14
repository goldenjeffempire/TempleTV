/**
 * Temple TV — Update Context
 *
 * Manages the lifecycle of both OTA and store-update detection across the app.
 * Mounted once at the root layout; all screens subscribe via `useUpdate()`.
 *
 * Behaviours:
 *   - On mount: check OTA immediately; check store version if not recently polled.
 *   - On app foreground (AppState active): re-check OTA silently.
 *   - Background interval: re-check store version every VERSION_CHECK_INTERVAL_MS.
 *   - Mandatory updates block the app until the user updates.
 *   - Optional updates show a dismissable banner (snoozed for 24 h after dismiss).
 *   - OTA updates auto-reload after a brief "Updating…" indicator.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, AppStateStatus, Linking, Platform } from "react-native";
import { retryPendingPushToken } from "@/services/notifications";
import Constants from "expo-constants";
import {
  type VersionCheckResult,
  applyOTAUpdate,
  checkForOTAUpdate,
  checkStoreVersion,
  clearBannerSnooze,
  clearVersionCheckTimestamp,
  isBannerSnoozed,
  markVersionCheckDone,
  semverLt,
  shouldPollVersionCheck,
  snoozeBanner,
} from "@/services/appUpdate";

const FOREGROUND_OTA_INTERVAL_MS = 30 * 60 * 1000; // 30 min between foreground OTA checks

// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateState {
  hasOTAUpdate:       boolean;
  isApplyingOTA:      boolean;
  otaUpdateId:        string | null;
  otaError:           string | null;

  hasStoreUpdate:     boolean;
  isMandatory:        boolean;
  isMandatoryBlocked: boolean;
  latestVersion:      string | null;
  releaseNotes:       string | null;
  storeUrl:           string | null;

  bannerVisible:      boolean;
  isChecking:         boolean;
}

export interface UpdateActions {
  applyOTA:           () => Promise<void>;
  openStore:          () => Promise<void>;
  dismissBanner:      () => Promise<void>;
  checkNow:           () => Promise<void>;
}

const defaultState: UpdateState = {
  hasOTAUpdate:       false,
  isApplyingOTA:      false,
  otaUpdateId:        null,
  otaError:           null,
  hasStoreUpdate:     false,
  isMandatory:        false,
  isMandatoryBlocked: false,
  latestVersion:      null,
  releaseNotes:       null,
  storeUrl:           null,
  bannerVisible:      false,
  isChecking:         false,
};

const StateCtx   = createContext<UpdateState>(defaultState);
const ActionsCtx = createContext<UpdateActions>({
  applyOTA:      async () => {},
  openStore:     async () => {},
  dismissBanner: async () => {},
  checkNow:      async () => {},
});

export function useUpdate(): UpdateState & UpdateActions {
  return { ...useContext(StateCtx), ...useContext(ActionsCtx) };
}

// ─────────────────────────────────────────────────────────────────────────────

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<UpdateState>(defaultState);
  const lastOtaCheckRef   = useRef<number>(0);
  const versionPollRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  const setPartial = useCallback((patch: Partial<UpdateState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // ── OTA check ──────────────────────────────────────────────────────────────

  const runOTACheck = useCallback(async () => {
    if (Platform.OS === "web") return;
    const now = Date.now();
    if (now - lastOtaCheckRef.current < FOREGROUND_OTA_INTERVAL_MS) return;
    lastOtaCheckRef.current = now;

    const result = await checkForOTAUpdate();
    if (result.isAvailable && !result.isRollback) {
      setPartial({
        hasOTAUpdate: true,
        otaUpdateId:  result.updateId,
        bannerVisible: true,
      });
    }
  }, [setPartial]);

  // ── Store version check ────────────────────────────────────────────────────

  const runVersionCheck = useCallback(async (force = false) => {
    if (Platform.OS === "web") return;
    if (!force && !(await shouldPollVersionCheck())) return;

    const result: VersionCheckResult | null = await checkStoreVersion();
    await markVersionCheckDone();

    if (!result?.updateAvailable) return;

    const currentVersion = Constants.expoConfig?.version ?? "0.0.0";
    const isMandatoryNow =
      result.isMandatory ||
      (result.minRequiredVersion != null &&
        semverLt(currentVersion, result.minRequiredVersion));

    const snoozed = isMandatoryNow ? false : await isBannerSnoozed();

    setPartial({
      hasStoreUpdate:     true,
      isMandatory:        isMandatoryNow,
      isMandatoryBlocked: isMandatoryNow,
      latestVersion:      result.latestVersion,
      releaseNotes:       result.releaseNotes,
      storeUrl:           result.storeUrl,
      bannerVisible:      !snoozed,
    });
  }, [setPartial]);

  // ── Full check (OTA + store) ───────────────────────────────────────────────

  const checkNow = useCallback(async () => {
    setPartial({ isChecking: true });
    try {
      lastOtaCheckRef.current = 0;          // force OTA check
      await AsyncStorage_clearBannerSnooze(); // force banner visible
      await Promise.all([runOTACheck(), runVersionCheck(true)]);
    } finally {
      setPartial({ isChecking: false });
    }
  }, [runOTACheck, runVersionCheck, setPartial]);

  // ── AppState foreground listener ───────────────────────────────────────────

  useEffect(() => {
    if (Platform.OS === "web") return;

    // Initial check
    void runOTACheck();
    void runVersionCheck();

    const sub = AppState.addEventListener("change", (status: AppStateStatus) => {
      if (status === "active") {
        void runOTACheck();
        // Also run the store version check — throttled to every 6 h by
        // shouldPollVersionCheck() unless clearVersionCheckTimestamp() was
        // called first (e.g. after tapping an app_update push notification),
        // in which case it fires immediately on foreground.
        void runVersionCheck();
        // Retry server-side push token registration for any token that was
        // obtained from EAS but failed to reach the server (e.g. first launch
        // with no network). The call is a fast no-op when no pending token exists.
        void retryPendingPushToken();
      }
    });

    // Background version poll (6 h interval)
    versionPollRef.current = setInterval(() => {
      void runVersionCheck();
    }, 6 * 60 * 60 * 1000);
    versionPollRef.current?.unref?.();

    return () => {
      sub.remove();
      if (versionPollRef.current) clearInterval(versionPollRef.current);
    };
  }, [runOTACheck, runVersionCheck]);

  // ── Push notification handler — listen for app_update type ────────────────
  useEffect(() => {
    if (Platform.OS === "web") return;
    const ENV: unknown = Constants?.executionEnvironment;
    const OWNERSHIP: unknown = (Constants as { appOwnership?: unknown })?.appOwnership;
    const isNativeBuild = ENV === "standalone" || ENV === "bare" || OWNERSHIP === "standalone";
    if (!isNativeBuild) return;

    let sub: { remove: () => void } | null = null;
    import("expo-notifications").then((N) => {
      sub = N.addNotificationReceivedListener((notification) => {
        const data = notification.request.content.data as Record<string, unknown>;
        if (data?.type === "app_update") {
          // Clear the rate-limit timestamp so the upcoming runVersionCheck actually fires,
          // then run it with force=true to bypass any remaining throttle window.
          clearVersionCheckTimestamp().catch(() => {}).finally(() => {
            void runVersionCheck(true);
          });
        }
      });
    }).catch(() => {});

    return () => { sub?.remove(); };
  }, [runVersionCheck]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const applyOTA = useCallback(async () => {
    if (!state.hasOTAUpdate || state.isApplyingOTA) return;
    setPartial({ isApplyingOTA: true, otaError: null, bannerVisible: false });

    const result = await applyOTAUpdate(state.otaUpdateId);
    if (!result.success) {
      setPartial({
        isApplyingOTA: false,
        otaError:      result.error ?? "Update failed",
        hasOTAUpdate:  false,
        bannerVisible: false,
      });
    }
    // On success: reloadAsync() was called; component will unmount — no state update needed
  }, [state.hasOTAUpdate, state.isApplyingOTA, state.otaUpdateId, setPartial]);

  const openStore = useCallback(async () => {
    const url = state.storeUrl;
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch {
      // Non-fatal
    }
  }, [state.storeUrl]);

  const dismissBanner = useCallback(async () => {
    if (state.isMandatory) return; // mandatory updates cannot be dismissed
    await snoozeBanner();
    setPartial({ bannerVisible: false });
  }, [state.isMandatory, setPartial]);

  const actions: UpdateActions = { applyOTA, openStore, dismissBanner, checkNow };

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>
        {children}
      </ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

// Wrapper so we don't import AsyncStorage in the context body directly
async function AsyncStorage_clearBannerSnooze() {
  try {
    await clearBannerSnooze();
  } catch {
    // Non-critical
  }
}
