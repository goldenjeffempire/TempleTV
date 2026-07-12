/**
 * Temple TV — Play Store In-App Update Service
 *
 * Production-grade orchestrator that sits between the raw ExpoInAppUpdates
 * module and the UpdateContext.  Handles:
 *
 *   • One-time-per-session check with exponential-backoff retry on failure
 *   • Anti-spam: per-version snooze (FLEXIBLE 7 d, IMMEDIATE never)
 *   • Automatic fallback to store-redirect when native API unavailable
 *   • Fire-and-forget telemetry to /api/telemetry/client-errors
 *   • Battery-friendly: at most MAX_CHECKS_PER_SESSION checks per launch
 *   • Singleton pattern — safe to call from multiple hooks simultaneously
 */

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import {
  UpdateType,
  checkForUpdate as nativeCheck,
  startUpdate as nativeStart,
  completeUpdate as nativeComplete,
  onInstallStateUpdate,
  isInAppUpdatesSupported,
  type PlayUpdateInfo,
  type InstallStateEvent,
  type InstallStatus,
} from "../modules/expo-in-app-updates/src/index";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { PlayUpdateInfo, InstallStatus };

export interface PlayUpdateState {
  status:               InstallStatus | "idle" | "checking" | "not_supported" | "unavailable";
  progress:             number;
  info:                 PlayUpdateInfo | null;
  error:                string | null;
}

type StateListener = (state: PlayUpdateState) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const FLEXIBLE_SNOOZE_PREFIX    = "@temple_tv/play_update_snooze_v:";
const FLEXIBLE_SNOOZE_DURATION  = 7 * 24 * 60 * 60 * 1000;  // 7 days
const MAX_CHECKS_PER_SESSION    = 3;
const CHECK_RETRY_DELAYS        = [2_000, 8_000, 30_000];
const FETCH_TIMEOUT_MS          = 12_000;

// ─────────────────────────────────────────────────────────────────────────────
// Singleton state
// ─────────────────────────────────────────────────────────────────────────────

let _state: PlayUpdateState = {
  status:   "idle",
  progress: 0,
  info:     null,
  error:    null,
};
let _checksThisSession  = 0;
let _checkInFlight      = false;
let _unsubNative: (() => void) | null = null;
const _listeners = new Set<StateListener>();

function setState(patch: Partial<PlayUpdateState>) {
  _state = { ..._state, ...patch };
  _listeners.forEach((fn) => { try { fn(_state); } catch { /**/ } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-spam helpers
// ─────────────────────────────────────────────────────────────────────────────

async function isFlexibleSnoozed(versionCode: number | null): Promise<boolean> {
  if (!versionCode) return false;
  try {
    const key = `${FLEXIBLE_SNOOZE_PREFIX}${versionCode}`;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return false;
    return Date.now() - parseInt(raw, 10) < FLEXIBLE_SNOOZE_DURATION;
  } catch {
    return false;
  }
}

async function snoozeFlexible(versionCode: number | null): Promise<void> {
  if (!versionCode) return;
  try {
    await AsyncStorage.setItem(
      `${FLEXIBLE_SNOOZE_PREFIX}${versionCode}`,
      String(Date.now()),
    );
  } catch { /**/ }
}

export async function clearFlexibleSnooze(versionCode: number | null): Promise<void> {
  if (!versionCode) return;
  try {
    await AsyncStorage.removeItem(`${FLEXIBLE_SNOOZE_PREFIX}${versionCode}`);
  } catch { /**/ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

function trackEvent(
  event:
    | "play_update_check_success"
    | "play_update_check_failed"
    | "play_update_not_supported"
    | "play_update_flexible_start"
    | "play_update_flexible_downloaded"
    | "play_update_immediate_start"
    | "play_update_complete"
    | "play_update_complete_failed"
    | "play_update_snoozed",
  meta?: Record<string, unknown>,
): void {
  try {
    const base = getApiBase();
    if (!base) return;
    const body = JSON.stringify({
      type:       "update_telemetry",
      eventType:  event,
      platform:   Platform.OS,
      appVersion: Constants.expoConfig?.version ?? "unknown",
      timestamp:  Date.now(),
      ...meta,
    });
    fetchWithRetry(`${base}/api/telemetry/client-errors`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => { /**/ });
  } catch { /**/ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Native event bridge
// ─────────────────────────────────────────────────────────────────────────────

function attachNativeListener() {
  if (_unsubNative) return;
  _unsubNative = onInstallStateUpdate((evt: InstallStateEvent) => {
    setState({
      status:   evt.status,
      progress: evt.progress,
      error:    evt.status === "failed" ? "Download failed — please try again" : null,
    });
    if (evt.status === "downloaded") {
      trackEvent("play_update_flexible_downloaded");
    }
  });
}

function detachNativeListener() {
  _unsubNative?.();
  _unsubNative = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to state changes.  Returns an unsubscribe function.
 * Always returns the current state synchronously on first call.
 */
export function subscribeToPlayUpdateState(listener: StateListener): {
  unsubscribe: () => void;
  currentState: PlayUpdateState;
} {
  _listeners.add(listener);
  return {
    currentState: _state,
    unsubscribe:  () => _listeners.delete(listener),
  };
}

export function getPlayUpdateState(): PlayUpdateState {
  return _state;
}

/**
 * Check for an available Play Store update.
 *
 * - Android + Play Store installs: native check
 * - iOS / web / dev builds: returns immediately with `status: "not_supported"`
 * - Retries up to 3 times on network failure (2s / 8s / 30s backoff)
 * - At most MAX_CHECKS_PER_SESSION per app launch
 * - Anti-spam: skips flexible check if already snoozed for this version
 *
 * After resolving, the singleton state is updated and all listeners are notified.
 */
export async function checkAndApplyPlayUpdate(options?: {
  force?: boolean;
}): Promise<PlayUpdateState> {
  if (Platform.OS !== "android") {
    setState({ status: "not_supported" });
    return _state;
  }

  if (!isInAppUpdatesSupported()) {
    setState({ status: "not_supported" });
    trackEvent("play_update_not_supported");
    return _state;
  }

  if (_checkInFlight) return _state;
  if (!options?.force && _checksThisSession >= MAX_CHECKS_PER_SESSION) return _state;

  _checkInFlight = true;
  _checksThisSession++;
  setState({ status: "checking", error: null });

  let info: PlayUpdateInfo | null = null;
  let lastErr = "";

  for (let attempt = 0; attempt < CHECK_RETRY_DELAYS.length; attempt++) {
    try {
      info = await nativeCheck();
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt < CHECK_RETRY_DELAYS.length - 1) {
        await new Promise<void>((r) => setTimeout(r, CHECK_RETRY_DELAYS[attempt]));
      }
    }
  }

  _checkInFlight = false;

  if (!info) {
    trackEvent("play_update_check_failed", { error: lastErr });
    setState({ status: "unavailable", error: lastErr });
    return _state;
  }

  trackEvent("play_update_check_success", {
    isAvailable:          info.isAvailable,
    isAlreadyDownloaded:  info.isAlreadyDownloaded,
    allowsFlexible:       info.allowsFlexible,
    allowsImmediate:      info.allowsImmediate,
    staleDays:            info.staleDays,
    versionCode:          info.availableVersionCode,
  });

  setState({ info });

  // ── Already downloaded from a previous session — prompt restart immediately
  if (info.isAlreadyDownloaded) {
    setState({ status: "downloaded", progress: 1 });
    attachNativeListener();
    return _state;
  }

  if (!info.isAvailable) {
    setState({ status: "unavailable" });
    return _state;
  }

  // ── Anti-spam: skip if user already snoozed this version
  if (info.allowsFlexible && !info.allowsImmediate) {
    const snoozed = await isFlexibleSnoozed(info.availableVersionCode);
    if (snoozed && !options?.force) {
      trackEvent("play_update_snoozed", { versionCode: info.availableVersionCode });
      setState({ status: "unavailable" });
      return _state;
    }
  }

  // ── Start flexible download automatically (background, non-blocking)
  if (info.allowsFlexible) {
    attachNativeListener();
    setState({ status: "downloading", progress: 0 });
    trackEvent("play_update_flexible_start", { versionCode: info.availableVersionCode });

    void (async () => {
      try {
        await nativeStart(UpdateType.FLEXIBLE);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        setState({ status: "failed", error });
      }
    })();

    return _state;
  }

  // ── Immediate update available but not flexible
  // We surface this to the context but do NOT auto-start it.
  // The UI (MandatoryUpdateGate) will call startImmediateUpdate() when ready.
  if (info.allowsImmediate) {
    setState({ status: "idle" });
  }

  return _state;
}

/**
 * Programmatically trigger a Google Play Immediate Update.
 * Typically called when a mandatory update gate is shown and user taps "Update Now".
 * Google Play takes over the full screen.
 */
export async function startImmediateUpdate(): Promise<void> {
  if (!isInAppUpdatesSupported()) throw new Error("Not supported");
  trackEvent("play_update_immediate_start");
  await nativeStart(UpdateType.IMMEDIATE);
}

/**
 * Trigger the restart to apply a downloaded flexible update.
 * Only call this after status === "downloaded".
 */
export async function completeFlexibleUpdate(): Promise<void> {
  try {
    trackEvent("play_update_complete");
    await nativeComplete();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    trackEvent("play_update_complete_failed", { error });
    setState({ error });
    throw err;
  }
}

/**
 * Snooze the current flexible update for 7 days and reset state to idle.
 */
export async function snoozeCurrentUpdate(): Promise<void> {
  const versionCode = _state.info?.availableVersionCode ?? null;
  await snoozeFlexible(versionCode);
  detachNativeListener();
  setState({ status: "unavailable", progress: 0, error: null });
}

/**
 * Reset session check counter (e.g. after a forced check from settings).
 */
export function resetSessionCheckCount(): void {
  _checksThisSession = 0;
}
