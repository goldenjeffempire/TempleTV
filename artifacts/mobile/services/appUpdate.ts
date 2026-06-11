/**
 * Temple TV — App Update Service
 *
 * Production-grade auto-update system combining:
 *   1. Expo EAS OTA updates  — instant JS bundle delivery for compatible runtimes
 *   2. Store version check   — API-driven mandatory/optional store-update detection
 *
 * Update flow:
 *   - On app foreground + every APP_STATE_CHECK_INTERVAL_MS, check OTA silently.
 *   - Every VERSION_CHECK_INTERVAL_MS, call /api/app/version-check for store updates.
 *   - Mandatory store updates block the app via MandatoryUpdateGate.
 *   - Optional updates show a dismissable UpdateBanner (respects SNOOZE_DURATION_MS).
 *   - Failed OTA IDs are persisted so the same bad bundle is never retried (rollback protection).
 *   - All events are reported to /api/telemetry/client-errors as update_* events.
 */

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

const FAILED_UPDATES_KEY    = "@temple_tv/failed_ota_ids";
const DISMISSED_BANNER_KEY  = "@temple_tv/update_banner_dismissed_at";
const LAST_CHECK_KEY        = "@temple_tv/last_version_check_at";

const VERSION_CHECK_INTERVAL_MS   = 6 * 60 * 60 * 1000;  // 6 hours
const SNOOZE_DURATION_MS          = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS            = 10_000;
const MAX_OTA_RETRY_ATTEMPTS      = 3;

export interface VersionCheckResult {
  updateAvailable:      boolean;
  isMandatory:          boolean;
  latestVersion:        string;
  latestVersionCode:    number;
  minRequiredVersion:   string | null;
  releaseNotes:         string | null;
  storeUrl:             string | null;
  channel:              string;
}

export interface OTAUpdateResult {
  isAvailable:   boolean;
  isRollback:    boolean;
  updateId:      string | null;
  error?:        string;
}

export interface ApplyOTAResult {
  success:       boolean;
  willReload:    boolean;
  error?:        string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semver comparison helpers — no external deps
// ─────────────────────────────────────────────────────────────────────────────

function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function semverGt(a: string, b: string): boolean {
  const [a0, a1, a2] = parseSemver(a);
  const [b0, b1, b2] = parseSemver(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

export function semverLt(a: string, b: string): boolean {
  return semverGt(b, a);
}

export function semverEq(a: string, b: string): boolean {
  return !semverGt(a, b) && !semverLt(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// OTA update helpers (uses expo-updates dynamically to avoid Expo Go crashes)
// ─────────────────────────────────────────────────────────────────────────────

const ENV: unknown = Constants?.executionEnvironment;
const OWNERSHIP: unknown = (Constants as { appOwnership?: unknown })?.appOwnership;
const IS_NATIVE_BUILD =
  ENV === "standalone" || ENV === "bare" || OWNERSHIP === "standalone";

let _Updates: typeof import("expo-updates") | null = null;

function getUpdates(): typeof import("expo-updates") | null {
  if (Platform.OS === "web") return null;
  if (!IS_NATIVE_BUILD) return null;
  if (_Updates) return _Updates;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _Updates = require("expo-updates") as typeof import("expo-updates");
    return _Updates;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback protection — track OTA IDs that failed to apply cleanly
// ─────────────────────────────────────────────────────────────────────────────

async function getFailedUpdateIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(FAILED_UPDATES_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

async function markUpdateFailed(updateId: string): Promise<void> {
  try {
    const failed = await getFailedUpdateIds();
    failed.add(updateId);
    await AsyncStorage.setItem(FAILED_UPDATES_KEY, JSON.stringify([...failed]));
  } catch {
    // Non-critical
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry — fire-and-forget to /api/telemetry/client-errors
// ─────────────────────────────────────────────────────────────────────────────

function trackUpdateEvent(
  eventType:
    | "update_check_ota_available"
    | "update_check_ota_none"
    | "update_check_ota_error"
    | "update_apply_started"
    | "update_apply_success"
    | "update_apply_error"
    | "update_apply_rollback_blocked"
    | "update_version_check_available"
    | "update_version_check_mandatory"
    | "update_version_check_error",
  meta?: Record<string, unknown>,
): void {
  const base = getApiBase();
  if (!base) return;
  const appVersion = Constants.expoConfig?.version ?? "unknown";
  const platform   = Platform.OS;
  const body = JSON.stringify({
    type:       "update_telemetry",
    eventType,
    appVersion,
    platform,
    channel:    getUpdates()?.channel ?? "unknown",
    updateId:   getUpdates()?.updateId ?? null,
    ...meta,
    timestamp:  Date.now(),
  });
  fetchWithRetry(`${base}/api/telemetry/client-errors`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal:  AbortSignal.timeout(8_000),
  }).catch(() => {/* non-critical */});
}

// ─────────────────────────────────────────────────────────────────────────────
// OTA update check + apply
// ─────────────────────────────────────────────────────────────────────────────

export async function checkForOTAUpdate(): Promise<OTAUpdateResult> {
  const Updates = getUpdates();
  if (!Updates) return { isAvailable: false, isRollback: false, updateId: null };

  try {
    const result = await Updates.checkForUpdateAsync();

    if ("isRollBackToEmbedded" in result && result.isRollBackToEmbedded) {
      return { isAvailable: true, isRollback: true, updateId: null };
    }

    if (!result.isAvailable) {
      trackUpdateEvent("update_check_ota_none");
      return { isAvailable: false, isRollback: false, updateId: null };
    }

    // Check rollback protection — skip if this update ID previously failed
    const manifest = (result as { manifest?: { id?: string } }).manifest;
    const updateId = manifest?.id ?? null;
    if (updateId) {
      const failed = await getFailedUpdateIds();
      if (failed.has(updateId)) {
        trackUpdateEvent("update_apply_rollback_blocked", { updateId });
        return { isAvailable: false, isRollback: false, updateId };
      }
    }

    trackUpdateEvent("update_check_ota_available", { updateId });
    return { isAvailable: true, isRollback: false, updateId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    trackUpdateEvent("update_check_ota_error", { error });
    return { isAvailable: false, isRollback: false, updateId: null, error };
  }
}

/**
 * Fetch and apply an OTA update, then reload.
 * Retries up to MAX_OTA_RETRY_ATTEMPTS before giving up.
 * Marks failed update IDs so they are never retried across sessions.
 */
export async function applyOTAUpdate(updateId: string | null): Promise<ApplyOTAResult> {
  const Updates = getUpdates();
  if (!Updates) return { success: false, willReload: false, error: "expo-updates not available" };

  trackUpdateEvent("update_apply_started", { updateId });

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_OTA_RETRY_ATTEMPTS; attempt++) {
    try {
      const fetchResult = await Updates.fetchUpdateAsync();

      if (!("isNew" in fetchResult) || !fetchResult.isNew) {
        return { success: true, willReload: false };
      }

      trackUpdateEvent("update_apply_success", { updateId, attempt });
      await Updates.reloadAsync();
      return { success: true, willReload: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_OTA_RETRY_ATTEMPTS) {
        await new Promise<void>((r) => setTimeout(r, attempt * 2000));
      }
    }
  }

  // All retries exhausted — mark this bundle as bad
  if (updateId) await markUpdateFailed(updateId);
  trackUpdateEvent("update_apply_error", { updateId, error: lastError });
  return { success: false, willReload: false, error: lastError };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store version check via API
// ─────────────────────────────────────────────────────────────────────────────

export async function checkStoreVersion(): Promise<VersionCheckResult | null> {
  const base = getApiBase();
  if (!base) return null;

  try {
    const platform    = Platform.OS as "ios" | "android";
    const version     = Constants.expoConfig?.version ?? "0.0.0";
    const versionCode = (
      Platform.OS === "android"
        ? Constants.expoConfig?.android?.versionCode
        : undefined
    ) ?? 0;
    const channel     = getUpdates()?.channel ?? "production";

    const params = new URLSearchParams({
      platform,
      version,
      versionCode: String(versionCode),
      channel,
    });

    const res = await fetchWithRetry(
      `${base}/api/app/version-check?${params.toString()}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );

    if (!res.ok) return null;

    const data = await res.json() as VersionCheckResult;
    return data;
  } catch (err) {
    trackUpdateEvent("update_version_check_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Banner / snooze persistence
// ─────────────────────────────────────────────────────────────────────────────

export async function isBannerSnoozed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_BANNER_KEY);
    if (!raw) return false;
    return Date.now() - parseInt(raw, 10) < SNOOZE_DURATION_MS;
  } catch {
    return false;
  }
}

export async function snoozeBanner(): Promise<void> {
  try {
    await AsyncStorage.setItem(DISMISSED_BANNER_KEY, String(Date.now()));
  } catch {
    // Non-critical
  }
}

export async function clearBannerSnooze(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DISMISSED_BANNER_KEY);
  } catch {
    // Non-critical
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit version API polls
// ─────────────────────────────────────────────────────────────────────────────

export async function shouldPollVersionCheck(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LAST_CHECK_KEY);
    if (!raw) return true;
    return Date.now() - parseInt(raw, 10) >= VERSION_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

export async function markVersionCheckDone(): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // Non-critical
  }
}

/** Clear the rate-limit timestamp so the next `shouldPollVersionCheck()` returns true. */
export async function clearVersionCheckTimestamp(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_CHECK_KEY);
  } catch {
    // Non-critical
  }
}
