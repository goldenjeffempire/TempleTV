/**
 * Temple TV — Update Context
 *
 * Manages the lifecycle of OTA updates, API-based store version checks, AND
 * Google Play In-App Updates (Android).  Mounted once at the root layout;
 * all screens subscribe via `useUpdate()`.
 *
 * Behaviours:
 *   - On mount: check OTA immediately; check store version if not recently polled.
 *   - On app foreground (AppState active): re-check OTA silently.
 *   - Background interval: re-check store version every 6 h.
 *   - Play In-App Updates (Android only): checked on mount + foreground (throttled
 *     to 30 min).  Flexible downloads run in-background with progress reporting.
 *     Mandatory updates (server flag OR stale ≥ 5 days) auto-start IMMEDIATE flow.
 *   - Mandatory updates block the app until the user updates.
 *   - Optional updates show a dismissable banner (snoozed 24 h after dismiss).
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
import {
  type PlayUpdateActions,
  type PlayUpdateState,
  usePlayInAppUpdates,
} from "@/hooks/usePlayInAppUpdates";

const FOREGROUND_OTA_INTERVAL_MS = 30 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// State + actions types
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateState {
  // OTA (expo-updates)
  hasOTAUpdate:       boolean;
  isApplyingOTA:      boolean;
  otaUpdateId:        string | null;
  otaError:           string | null;

  // API-based store version check
  hasStoreUpdate:     boolean;
  isMandatory:        boolean;
  isMandatoryBlocked: boolean;
  latestVersion:      string | null;
  releaseNotes:       string | null;
  storeUrl:           string | null;
  bannerVisible:      boolean;
  isChecking:         boolean;

  // Play In-App Updates (Android only)
  play:               PlayUpdateState;
}

export interface UpdateActions {
  applyOTA:           () => Promise<void>;
  openStore:          () => Promise<void>;
  dismissBanner:      () => Promise<void>;
  checkNow:           () => Promise<void>;

  // Play In-App Updates actions (Android only — no-ops on other platforms)
  playActions:        PlayUpdateActions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const defaultPlayState: PlayUpdateState = {
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

const noopAsync = async () => {};
const noop      = () => {};

const defaultPlayActions: PlayUpdateActions = {
  startFlexibleUpdate:  noopAsync,
  startImmediateUpdate: noopAsync,
  restartForUpdate:     noopAsync,
  retryDownload:        noopAsync,
  dismissSheet:         noop,
  checkNow:             noopAsync,
};

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
  play:               defaultPlayState,
};

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

const StateCtx   = createContext<UpdateState>(defaultState);
const ActionsCtx = createContext<UpdateActions>({
  applyOTA:      noopAsync,
  openStore:     noopAsync,
  dismissBanner: noopAsync,
  checkNow:      noopAsync,
  playActions:   defaultPlayActions,
});

export function useUpdate(): UpdateState & UpdateActions {
  return { ...useContext(StateCtx), ...useContext(ActionsCtx) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<UpdateState>(defaultState);
  const lastOtaCheckRef   = useRef<number>(0);
  const versionPollRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  const setPartial = useCallback((patch: Partial<Omit<UpdateState, "play">>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // ── Google Play In-App Updates ─────────────────────────────────────────────
  // Pass `isMandatory` so the Play update hook auto-escalates when the API
  // version check marks this version as mandatory.

  const playUpdate = usePlayInAppUpdates(state.isMandatory);

  // Sync play state into the main state tree so the whole app can read it via useUpdate()
  useEffect(() => {
    const {
      startFlexibleUpdate,  // eslint-disable-line
      startImmediateUpdate, // eslint-disable-line
      restartForUpdate,     // eslint-disable-line
      retryDownload,        // eslint-disable-line
      dismissSheet,         // eslint-disable-line
      checkNow: _cn,        // eslint-disable-line
      ...playState
    } = playUpdate;

    setState((prev) => {
      // Bail out of re-render if play state hasn't changed
      if (
        prev.play.isAvailable   === playState.isAvailable   &&
        prev.play.isDownloading === playState.isDownloading &&
        prev.play.isDownloaded  === playState.isDownloaded  &&
        prev.play.isMandatory   === playState.isMandatory   &&
        prev.play.progress      === playState.progress      &&
        prev.play.status        === playState.status        &&
        prev.play.sheetVisible  === playState.sheetVisible  &&
        prev.play.error         === playState.error         &&
        prev.play.versionCode   === playState.versionCode
      ) return prev;
      return { ...prev, play: playState };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    playUpdate.isAvailable,
    playUpdate.isDownloading,
    playUpdate.isDownloaded,
    playUpdate.isMandatory,
    playUpdate.progress,
    playUpdate.status,
    playUpdate.sheetVisible,
    playUpdate.error,
    playUpdate.versionCode,
  ]);

  // ── OTA check ──────────────────────────────────────────────────────────────

  const runOTACheck = useCallback(async () => {
    if (Platform.OS === "web") return;
    const now = Date.now();
    if (now - lastOtaCheckRef.current < FOREGROUND_OTA_INTERVAL_MS) return;
    lastOtaCheckRef.current = now;

    const result = await checkForOTAUpdate();
    if (result.isAvailable && !result.isRollback) {
      setPartial({
        hasOTAUpdate:  true,
        otaUpdateId:   result.updateId,
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
      lastOtaCheckRef.current = 0;
      await safelyClearBannerSnooze();
      await Promise.all([runOTACheck(), runVersionCheck(true)]);
      // Also force-trigger the Play update check
      await playUpdate.checkNow();
    } finally {
      setPartial({ isChecking: false });
    }
  }, [runOTACheck, runVersionCheck, setPartial, playUpdate.checkNow]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── AppState foreground listener ───────────────────────────────────────────

  useEffect(() => {
    if (Platform.OS === "web") return;

    void runOTACheck();
    void runVersionCheck();

    const sub = AppState.addEventListener("change", (status: AppStateStatus) => {
      if (status === "active") {
        void runOTACheck();
        void runVersionCheck();
        void retryPendingPushToken();
        // Play In-App Updates has its own AppState listener inside usePlayInAppUpdates
      }
    });

    versionPollRef.current = setInterval(() => {
      void runVersionCheck();
    }, 6 * 60 * 60 * 1000);
    // .unref() is a Node.js-only handle API — React Native setInterval returns
    // a plain number and has no unref(). Cast to any to safely call it only
    // in Node environments (e.g. Jest tests) without a TS error.
    (versionPollRef.current as unknown as { unref?: () => void })?.unref?.();

    return () => {
      sub.remove();
      if (versionPollRef.current) clearInterval(versionPollRef.current);
    };
  }, [runOTACheck, runVersionCheck]);

  // ── Push notification → app_update ────────────────────────────────────────

  useEffect(() => {
    if (Platform.OS === "web") return;
    const ENV: unknown       = Constants?.executionEnvironment;
    const OWNERSHIP: unknown = (Constants as { appOwnership?: unknown })?.appOwnership;
    const isNativeBuild =
      ENV === "standalone" || ENV === "bare" || OWNERSHIP === "standalone";
    if (!isNativeBuild) return;

    let sub: { remove: () => void } | null = null;
    import("expo-notifications").then((N) => {
      sub = N.addNotificationReceivedListener((notification) => {
        const data = notification.request.content.data as Record<string, unknown>;
        if (data?.type === "app_update") {
          clearVersionCheckTimestamp().catch(() => {}).finally(() => {
            void runVersionCheck(true);
            void playUpdate.checkNow();
          });
        }
      });
    }).catch(() => {});

    return () => { sub?.remove(); };
  }, [runVersionCheck, playUpdate.checkNow]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── OTA actions ────────────────────────────────────────────────────────────

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
  }, [state.hasOTAUpdate, state.isApplyingOTA, state.otaUpdateId, setPartial]);

  const openStore = useCallback(async () => {
    const url = state.storeUrl;
    if (!url) return;
    try { await Linking.openURL(url); } catch { /* non-fatal */ }
  }, [state.storeUrl]);

  const dismissBanner = useCallback(async () => {
    if (state.isMandatory) return;
    await snoozeBanner();
    setPartial({ bannerVisible: false });
  }, [state.isMandatory, setPartial]);

  // ── Play actions proxy ─────────────────────────────────────────────────────

  const playActions: PlayUpdateActions = {
    startFlexibleUpdate:  playUpdate.startFlexibleUpdate,
    startImmediateUpdate: playUpdate.startImmediateUpdate,
    restartForUpdate:     playUpdate.restartForUpdate,
    retryDownload:        playUpdate.retryDownload,
    dismissSheet:         playUpdate.dismissSheet,
    checkNow:             playUpdate.checkNow,
  };

  const actions: UpdateActions = {
    applyOTA,
    openStore,
    dismissBanner,
    checkNow,
    playActions,
  };

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>
        {children}
      </ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

async function safelyClearBannerSnooze() {
  try { await clearBannerSnooze(); } catch { /* non-critical */ }
}
