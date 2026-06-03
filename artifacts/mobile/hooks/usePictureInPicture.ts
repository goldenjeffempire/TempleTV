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
 *     showRestoreButton: true,       // add restore button + notification
 *   });
 *
 * PiP mode detection:
 *   Android does not propagate onPictureInPictureModeChanged to the JS thread
 *   via any standard RN API. We detect it by polling `isInPictureInPictureMode()`
 *   on every AppState change (active ↔ background). This is accurate and
 *   battery-neutral since we poll only on state-change events, not on a timer.
 *
 * Restore button (showRestoreButton = true):
 *   • Adds a "fullscreen" icon action to the PiP overlay window itself.
 *   • Posts a persistent low-priority notification "Playing in mini player —
 *     tap to return to full screen" so the user can restore from anywhere.
 *   • Both are automatically dismissed by the native module when the activity
 *     next resumes (user returned via the button, notification, or task switcher).
 *   • cancelPipRestoreNotification() is called from JS on PiP exit as a
 *     belt-and-suspenders cleanup in case the native cancel fires first.
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
  cancelPipRestoreNotification,
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
  /**
   * When true, entering PiP adds a "Return to full screen" button inside the
   * PiP overlay window AND posts a persistent notification in the notification
   * drawer so the user can restore the player from anywhere without hunting
   * for the app. Both are dismissed automatically when the player returns to
   * the foreground.
   * Default: true on Android (ignored on iOS/web).
   */
  showRestoreButton?: boolean;
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
    showRestoreButton = true,
  } = options;

  const [isSupported] = useState<boolean>(() => {
    if (Platform.OS !== "android") return false;
    return isPictureInPictureSupported();
  });

  // Bug fix: initialize from the actual PiP mode state rather than hardcoding
  // false. If the component remounts while the app is already in a PiP window
  // (e.g. Expo Router re-renders the Player screen after a navigation), the
  // initial value will be correct and UI elements that hide in PiP will render
  // properly from the first frame instead of briefly flashing visible.
  const [isInPip, setIsInPip] = useState<boolean>(() => {
    if (Platform.OS !== "android") return false;
    try {
      return isInPictureInPictureMode();
    } catch {
      return false;
    }
  });

  // Keep latest options in refs so the AppState handler doesn't stale-close
  // over them (avoids re-registering the handler on every option change).
  const aspectRef = useRef({ width: aspectRatioWidth, height: aspectRatioHeight });
  const autoEnterRef = useRef(autoEnterOnBackground);
  const showRestoreRef = useRef(showRestoreButton);
  useEffect(() => {
    aspectRef.current = { width: aspectRatioWidth, height: aspectRatioHeight };
    autoEnterRef.current = autoEnterOnBackground;
    showRestoreRef.current = showRestoreButton;
  }, [aspectRatioWidth, aspectRatioHeight, autoEnterOnBackground, showRestoreButton]);

  const enterPip = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;
    const entered = await enterPictureInPicture(
      aspectRef.current.width,
      aspectRef.current.height,
      showRestoreRef.current,
    );
    // Bug fix: update isInPip immediately when the system accepts the PiP
    // request rather than waiting for the next AppState event. Without this,
    // isInPip stays false until AppState fires, leaving PiP-hidden elements
    // (controls, countdown overlay, chat) briefly visible inside the PiP
    // window — a jarring flash on every manual PiP entry.
    if (entered) setIsInPip(true);
    return entered;
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

      // When transitioning from PiP → active, cancel the restore notification
      // as a JS-side belt-and-suspenders (the native module's ActivityLifecycle
      // callbacks already cancel it on onActivityResumed; this covers the case
      // where the native callback fires before React state updates).
      if (nextState === "active" && !inPip) {
        cancelPipRestoreNotification().catch(() => {});
      }

      // Auto-enter PiP when the app is backgrounded (user pressed Home / switched apps).
      if (
        autoEnterRef.current &&
        (nextState === "background" || nextState === "inactive") &&
        !inPip
      ) {
        // Bug fix: chain .then() to set isInPip=true immediately when the
        // system accepts the PiP request. Without this, the auto-enter path
        // NEVER sets isInPip=true because the AppState check above runs
        // BEFORE enterPictureInPicture() completes — so isInPip stays false
        // for the entire PiP session, leaving controls visible in the PiP window.
        enterPictureInPicture(
          aspectRef.current.width,
          aspectRef.current.height,
          showRestoreRef.current,
        ).then((entered) => {
          if (entered) setIsInPip(true);
        }).catch(() => {});
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [isSupported]);

  return { isSupported, isInPip, enterPip };
}
