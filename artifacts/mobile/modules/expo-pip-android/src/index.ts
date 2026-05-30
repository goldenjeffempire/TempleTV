/**
 * expo-pip-android — Temple TV local native module
 *
 * Wraps Android's PictureInPicture API (API 26+) for use from React Native.
 * On unsupported platforms (iOS, web, Android < 8) all functions are no-ops
 * that return safe defaults so callers never need to guard on Platform.OS.
 *
 * Restore button (withRestore = true):
 *   Adds a "fullscreen" icon button inside the PiP overlay window AND posts a
 *   persistent notification so the user can return to the full player from
 *   anywhere — without hunting for the app. Both are dismissed automatically
 *   when the activity next resumes (player returned to foreground).
 */
import { Platform } from "react-native";

let NativeModule: {
  enterPictureInPicture(
    aspectWidth: number,
    aspectHeight: number,
    withRestore: boolean,
  ): Promise<boolean>;
  isPictureInPictureSupported(): boolean;
  isInPictureInPictureMode(): boolean;
  updatePipParams(
    aspectWidth: number,
    aspectHeight: number,
    withRestore: boolean,
  ): Promise<void>;
  cancelPipRestoreNotification(): Promise<void>;
} | null = null;

if (Platform.OS === "android") {
  try {
    const { requireNativeModule } = require("expo-modules-core");
    NativeModule = requireNativeModule("ExpoPipAndroid");
  } catch {
    NativeModule = null;
  }
}

/**
 * Attempt to enter Android Picture-in-Picture mode.
 *
 * @param aspectWidth  Numerator of the desired PiP window aspect ratio (e.g. 16).
 * @param aspectHeight Denominator of the desired PiP window aspect ratio (e.g. 9).
 * @param withRestore  When true, adds a "Return to full screen" button to the PiP
 *                     overlay and posts a persistent notification so the user can
 *                     restore the player from anywhere. Both are auto-dismissed when
 *                     the activity next resumes. Default: false.
 * @returns            Promise<boolean> — true if the system accepted the PiP request.
 */
export async function enterPictureInPicture(
  aspectWidth = 16,
  aspectHeight = 9,
  withRestore = false,
): Promise<boolean> {
  if (!NativeModule) return false;
  try {
    return await NativeModule.enterPictureInPicture(
      Math.max(1, Math.round(aspectWidth)),
      Math.max(1, Math.round(aspectHeight)),
      withRestore,
    );
  } catch {
    return false;
  }
}

/**
 * Returns true if the device supports Picture-in-Picture (API 26+, feature flag present).
 * Always false on iOS, web, and Android < 8.
 */
export function isPictureInPictureSupported(): boolean {
  return NativeModule?.isPictureInPictureSupported() ?? false;
}

/**
 * Returns true if the app is currently displayed in a Picture-in-Picture window.
 * Requires API 26+. Always false on iOS, web, and Android < 8.
 *
 * Useful for polling on AppState changes to detect PiP enter/exit without
 * needing a native lifecycle observer.
 */
export function isInPictureInPictureMode(): boolean {
  return NativeModule?.isInPictureInPictureMode() ?? false;
}

/**
 * Update PiP window parameters without re-entering PiP mode. Useful for
 * adding or removing the restore action button dynamically while already
 * in PiP, or for pre-registering params before the next PiP entry so
 * Android uses the correct aspect ratio and actions immediately.
 *
 * No-op when PiP is not supported.
 */
export async function updatePipParams(
  aspectWidth = 16,
  aspectHeight = 9,
  withRestore = false,
): Promise<void> {
  if (!NativeModule) return;
  try {
    await NativeModule.updatePipParams(
      Math.max(1, Math.round(aspectWidth)),
      Math.max(1, Math.round(aspectHeight)),
      withRestore,
    );
  } catch {
    // non-fatal
  }
}

/**
 * Explicitly dismiss the PiP restore notification. The module auto-cancels
 * it when the activity resumes; call this from JS if you need to dismiss
 * it earlier (e.g. user stopped playback while the app is in the background).
 */
export async function cancelPipRestoreNotification(): Promise<void> {
  if (!NativeModule) return;
  try {
    await NativeModule.cancelPipRestoreNotification();
  } catch {
    // non-fatal
  }
}
