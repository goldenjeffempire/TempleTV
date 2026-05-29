/**
 * usePictureInPicture — Android Picture-in-Picture React hook for Temple TV.
 *
 * Wraps the expo-pip-android local native module with React state and
 * AppState-based PiP-mode detection.
 *
 * Usage:
 *   const { isInPip, isSupported, enterPip } = usePictureInPicture({
 *     aspectRatioWidth: 16,
 *     aspectRatioHeight: 9,
 *     autoEnterOnBackground: true,   // enter PiP when user presses home
 *   });
 *
 * PiP mode detection:
 *   Android does not propagate onPictureInPictureModeChanged to the JS thread
 *   via any standard RN API. We detect it by polling `isInPictureInPictureMode()`
 *   on every AppState change (active ↔ background). This is accurate and
 *   battery-neutral since we poll only on state-change events, not on a timer.
 *
 * iOS / web:
 *   All exported values are safe no-ops — isSupported=false, isInPip=false,
 *   enterPip() is a no-op that returns false. Callers need no Platform guard.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";
import {
  enterPictureInPicture,
  isPictureInPictureSupported,
  isInPictureInPictureMode,
} from "../modules/expo-pip-android/src";

export interface UsePictureInPictureOptions {
  /**
   * Numerator of the desired PiP window aspect ratio.
   * Default: 16 (16:9 landscape).
   */
  aspectRatioWidth?: number;
  /**
   * Denominator of the desired PiP window aspect ratio.
   * Default: 9 (16:9 landscape).
   */
  aspectRatioHeight?: number;
  /**
   * When true, the hook automatically calls enterPictureInPicture() when
   * the app is sent to the background while this hook is mounted.
   *
   * Set to true in the player screen when a video is actively playing so
   * the video continues in a small PiP window when the user presses Home.
   * Default: false.
   */
  autoEnterOnBackground?: boolean;
}

export interface UsePictureInPictureResult {
  /** True when the device supports PiP (Android 8+ with the PiP feature flag). */
  isSupported: boolean;
  /** True when the app is currently displayed in a PiP window. */
  isInPip: boolean;
  /**
   * Requests PiP mode immediately. Resolves with true if the system accepted
   * the request, false if PiP is unavailable or the request was rejected.
   */
  enterPip: () => Promise<boolean>;
}

export function usePictureInPicture(
  options: UsePictureInPictureOptions = {},
): UsePictureInPictureResult {
  const {
    aspectRatioWidth = 16,
    aspectRatioHeight = 9,
    autoEnterOnBackground = false,
  } = options;

  const [isInPip, setIsInPip] = useState(false);

  const [isSupported] = useState<boolean>(() => {
    if (Platform.OS !== "android") return false;
    return isPictureInPictureSupported();
  });

  // Keep latest options in refs so the AppState handler doesn't stale-close
  // over them (avoids re-registering the handler on every option change).
  const aspectRef = useRef({ width: aspectRatioWidth, height: aspectRatioHeight });
  const autoEnterRef = useRef(autoEnterOnBackground);
  useEffect(() => {
    aspectRef.current = { width: aspectRatioWidth, height: aspectRatioHeight };
    autoEnterRef.current = autoEnterOnBackground;
  }, [aspectRatioWidth, aspectRatioHeight, autoEnterOnBackground]);

  const enterPip = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;
    return enterPictureInPicture(
      aspectRef.current.width,
      aspectRef.current.height,
    );
  }, [isSupported]);

  // Poll isInPictureInPictureMode() on every AppState transition.
  // This is the only reliable cross-API-level way to detect PiP mode from JS.
  useEffect(() => {
    if (!isSupported) return;

    const handleAppState = (nextState: AppStateStatus) => {
      // Check PiP mode after every state change — handles both enter (background)
      // and exit (active) transitions.
      const inPip = isInPictureInPictureMode();
      setIsInPip(inPip);

      // Auto-enter PiP when the app is backgrounded (user pressed Home / switched apps).
      if (
        autoEnterRef.current &&
        (nextState === "background" || nextState === "inactive") &&
        !inPip
      ) {
        enterPictureInPicture(aspectRef.current.width, aspectRef.current.height).catch(
          () => {},
        );
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [isSupported]);

  return { isSupported, isInPip, enterPip };
}
