/**
 * expo-in-app-updates — Temple TV local native module
 *
 * Wraps Google Play In-App Updates API (Play Core 2.x) for use from React Native.
 *
 * Safety guarantees:
 *   - All functions are no-ops that return safe defaults on iOS, web, and
 *     Android builds not installed from the Play Store.
 *   - Errors from the native layer are caught and surfaced via thrown Error.
 *   - The native module is loaded lazily so non-Android builds never import it.
 *
 * Lifecycle:
 *   1. Call checkForUpdate() once on app launch / foreground.
 *   2. If isAlreadyDownloaded → call completeUpdate() after prompting the user.
 *   3. If isAvailable + allowsFlexible → call startUpdate(UpdateType.FLEXIBLE).
 *      Subscribe to onInstallStateUpdate events for download progress.
 *      When status "downloaded" → call completeUpdate() after prompting.
 *   4. If isAvailable + allowsImmediate (and you choose to mandate it) →
 *      call startUpdate(UpdateType.IMMEDIATE).  Google Play takes over the UI.
 */

import { Platform } from "react-native";

export const UpdateType = {
  FLEXIBLE:  0,
  IMMEDIATE: 1,
} as const;
export type UpdateType = (typeof UpdateType)[keyof typeof UpdateType];

export interface PlayUpdateInfo {
  isAvailable:           boolean;
  isAlreadyDownloaded:   boolean;
  allowsFlexible:        boolean;
  allowsImmediate:       boolean;
  staleDays:             number | null;
  availableVersionCode:  number | null;
}

export type InstallStatus =
  | "idle"
  | "pending"
  | "downloading"
  | "downloaded"
  | "installing"
  | "installed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface InstallStateEvent {
  status:               InstallStatus;
  progress:             number;
  bytesDownloaded:      number;
  totalBytesToDownload: number;
}

type StateListener = (event: InstallStateEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Native module bootstrap — lazy, Android-only, safe to import anywhere
// ─────────────────────────────────────────────────────────────────────────────

let NativeModule: {
  checkForUpdate(): Promise<PlayUpdateInfo>;
  startUpdate(updateType: number): Promise<number>;
  completeUpdate(): Promise<void>;
  unregisterListener(): Promise<void>;
} | null = null;

let NativeEventEmitter: {
  addListener(
    event: string,
    listener: (payload: InstallStateEvent) => void,
  ): { remove: () => void };
} | null = null;

let _initialized = false;

function init() {
  if (_initialized || Platform.OS !== "android") return;
  _initialized = true;
  try {
    const { requireNativeModule, EventEmitter } = require("expo-modules-core") as {
      requireNativeModule: (name: string) => typeof NativeModule;
      EventEmitter: new (module: unknown) => typeof NativeEventEmitter;
    };
    const mod = requireNativeModule("ExpoInAppUpdates");
    if (!mod) return;
    NativeModule = mod as typeof NativeModule;
    NativeEventEmitter = new EventEmitter(mod) as typeof NativeEventEmitter;
  } catch {
    NativeModule = null;
    NativeEventEmitter = null;
  }
}

// Subscription tracker for state listeners
const stateListeners = new Set<StateListener>();
let nativeSub: { remove: () => void } | null = null;

function ensureNativeSub() {
  if (nativeSub || !NativeEventEmitter) return;
  nativeSub = NativeEventEmitter.addListener("onInstallStateUpdate", (evt) => {
    stateListeners.forEach((fn) => {
      try { fn(evt); } catch { /**/ }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if this app is running on Android with the Google Play
 * In-App Updates API available.  Always false on iOS and web.
 */
export function isInAppUpdatesSupported(): boolean {
  init();
  return NativeModule !== null;
}

/**
 * Query the Play Store for pending update information.
 *
 * Returns null when the API is not supported (non-Play build, iOS, web).
 * Throws on network/Play error — callers should catch.
 */
export async function checkForUpdate(): Promise<PlayUpdateInfo | null> {
  init();
  if (!NativeModule) return null;
  return NativeModule.checkForUpdate();
}

/**
 * Begin an update flow.
 *
 * @param type UpdateType.FLEXIBLE (default) | UpdateType.IMMEDIATE
 *
 * FLEXIBLE: Play downloads the update in the background while the user
 * continues using the app. Subscribe to onInstallStateUpdate for progress.
 *
 * IMMEDIATE: Play takes over the full screen and blocks the app until the
 * update is complete or the user cancels.
 *
 * Resolves with the Activity result code (RESULT_OK = 0, CANCELLED = -1,
 * IN_APP_UPDATE_FAILED = 1).  Throws if not supported or Play API fails.
 */
export async function startUpdate(type: UpdateType = UpdateType.FLEXIBLE): Promise<number> {
  init();
  if (!NativeModule) throw new Error("Play In-App Updates not supported on this device");
  ensureNativeSub();
  return NativeModule.startUpdate(type);
}

/**
 * Trigger a restart to apply an already-downloaded flexible update.
 * No-op if nothing has been downloaded.
 */
export async function completeUpdate(): Promise<void> {
  init();
  if (!NativeModule) return;
  return NativeModule.completeUpdate();
}

/**
 * Detach the native install-state listener without destroying the module.
 * Call this when your component unmounts and you no longer need progress events.
 */
export async function unregisterListener(): Promise<void> {
  init();
  if (!NativeModule) return;
  return NativeModule.unregisterListener();
}

/**
 * Subscribe to install-state changes (download progress, completion, failures).
 * Returns an unsubscribe function.
 *
 * @example
 * const unsub = onInstallStateUpdate((evt) => {
 *   if (evt.status === "downloaded") promptRestart();
 * });
 * // later…
 * unsub();
 */
export function onInstallStateUpdate(listener: StateListener): () => void {
  init();
  ensureNativeSub();
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
    if (stateListeners.size === 0) {
      nativeSub?.remove();
      nativeSub = null;
    }
  };
}
