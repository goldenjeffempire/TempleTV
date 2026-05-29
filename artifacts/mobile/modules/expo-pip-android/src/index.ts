/**
 * expo-pip-android — Temple TV local native module
 *
 * Wraps Android's PictureInPicture API (API 26+) for use from React Native.
 * On unsupported platforms (iOS, web, Android < 8) all functions are no-ops
 * that return safe defaults so callers never need to guard on Platform.OS.
 */
import { Platform } from "react-native";

let NativeModule: {
  enterPictureInPicture(aspectWidth: number, aspectHeight: number): Promise<boolean>;
  isPictureInPictureSupported(): boolean;
  isInPictureInPictureMode(): boolean;
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
 * @returns            Promise<boolean> — true if the system accepted the PiP request,
 *                     false if PiP is not available or was rejected (e.g. on TV devices,
 *                     locked screen, or unsupported API level).
 */
export async function enterPictureInPicture(
  aspectWidth = 16,
  aspectHeight = 9,
): Promise<boolean> {
  if (!NativeModule) return false;
  try {
    return await NativeModule.enterPictureInPicture(
      Math.max(1, Math.round(aspectWidth)),
      Math.max(1, Math.round(aspectHeight)),
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
