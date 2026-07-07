/**
 * expo-pip-android — Temple TV local native module
 *
 * Wraps Android's PictureInPicture API (API 26+) for use from React Native.
 * On unsupported platforms (iOS, web, Android < 8) all functions are no-ops
 * that return safe defaults so callers never need to guard on Platform.OS.
 *
 * Media controls:
 *   Subscribe to "onPipAction" events (via addPipActionListener) to receive
 *   play/pause button taps from inside the PiP overlay window. The native
 *   module broadcasts these as { action: "play" | "pause" }.
 *
 * Restore button (withRestore = true):
 *   Adds a bundled "expand" icon button inside the PiP overlay window AND posts
 *   a persistent notification so the user can return to the full player from
 *   anywhere — without hunting for the app. Both are dismissed automatically
 *   when the activity next resumes (player returned to foreground).
 *
 * Title (Android 12+ / API 31):
 *   When provided, shown in the PiP window chrome above the video so viewers
 *   know what is currently playing (same as YouTube's PiP title treatment).
 */
import { type EventSubscription, Platform } from "react-native";

// EventEmitter was removed from the react-native public TS exports in 0.76+.
// Define a minimal interface matching the subset of the API we actually use so
// we never need to import from a package whose type diverges from runtime.
interface NativePipEmitter {
  addListener(
    event: string,
    listener: (event: PipActionEvent) => void,
  ): EventSubscription;
  removeAllListeners(event: string): void;
}

export interface PipActionEvent {
  /** "play" when the user taps Play in the PiP overlay; "pause" for Pause. */
  action: "play" | "pause";
}

let NativeModule: {
  enterPictureInPicture(
    aspectWidth: number,
    aspectHeight: number,
    withRestore: boolean,
    title: string | null,
    isPlaying: boolean,
  ): Promise<boolean>;
  isPictureInPictureSupported(): boolean;
  isInPictureInPictureMode(): boolean;
  updatePipParams(
    aspectWidth: number,
    aspectHeight: number,
    withRestore: boolean,
    autoEnter: boolean,
    title: string | null,
    isPlaying: boolean,
  ): Promise<void>;
  cancelPipRestoreNotification(): Promise<void>;
} | null = null;

let NativeEmitter: NativePipEmitter | null = null;

if (Platform.OS === "android") {
  try {
    // requireNativeModule is from expo-modules-core (already a dep of this module).
    const { requireNativeModule } = require("expo-modules-core") as {
      requireNativeModule: (name: string) => typeof NativeModule;
    };
    NativeModule = requireNativeModule("ExpoPipAndroid");
    // NativeEventEmitter is no longer exported from react-native's public index
    // (removed in 0.76+) but is still accessible via its internal path — this
    // is the correct way to bridge native event emission through the JS bridge.
    const { default: NativeEventEmitter } = require(
      "react-native/Libraries/EventEmitter/NativeEventEmitter",
    ) as { default: new (mod: unknown) => NativePipEmitter };
    NativeEmitter = new NativeEventEmitter(NativeModule);
  } catch {
    NativeModule = null;
    NativeEmitter = null;
  }
}

/**
 * Subscribe to media-control button taps from inside the PiP overlay.
 * Returns an EventSubscription that must be removed when the component unmounts.
 *
 * @example
 * useEffect(() => {
 *   const sub = addPipActionListener(({ action }) => {
 *     if (action === "pause") pausePlayback();
 *     if (action === "play")  resumePlayback();
 *   });
 *   return () => sub.remove();
 * }, []);
 */
export function addPipActionListener(
  listener: (event: PipActionEvent) => void,
): EventSubscription {
  if (!NativeEmitter) {
    return { remove: () => {} } as EventSubscription;
  }
  return NativeEmitter.addListener("onPipAction", listener);
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
 * @param title        Text shown in the PiP window chrome on Android 12+ (API 31).
 *                     Pass the video / broadcast title here. Falls back to "Temple TV".
 * @param isPlaying    When true, the PiP overlay shows a Pause button; when false,
 *                     a Play button. This matches the current playback state.
 */
export async function enterPictureInPicture(
  aspectWidth = 16,
  aspectHeight = 9,
  withRestore = false,
  title: string | null = null,
  isPlaying = true,
): Promise<boolean> {
  if (!NativeModule) return false;
  try {
    return await NativeModule.enterPictureInPicture(
      Math.max(1, Math.round(aspectWidth)),
      Math.max(1, Math.round(aspectHeight)),
      withRestore,
      title ?? null,
      isPlaying,
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
 */
export function isInPictureInPictureMode(): boolean {
  return NativeModule?.isInPictureInPictureMode() ?? false;
}

/**
 * Update PiP window parameters without re-entering PiP mode.
 *
 * Call this whenever the playback state changes (play ↔ pause) to keep the
 * PiP overlay's media control button in sync with actual playback. Also use
 * it to pre-register params before the next PiP entry on Android 12+ so the
 * OS uses the correct aspect ratio and title immediately.
 *
 * @param title     Video / broadcast title for the PiP window chrome (API 31+).
 * @param isPlaying Controls which media icon is shown: Pause when true, Play when false.
 */
export async function updatePipParams(
  aspectWidth = 16,
  aspectHeight = 9,
  withRestore = false,
  autoEnter = false,
  title: string | null = null,
  isPlaying = true,
): Promise<void> {
  if (!NativeModule) return;
  try {
    await NativeModule.updatePipParams(
      Math.max(1, Math.round(aspectWidth)),
      Math.max(1, Math.round(aspectHeight)),
      withRestore,
      autoEnter,
      title ?? null,
      isPlaying,
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
