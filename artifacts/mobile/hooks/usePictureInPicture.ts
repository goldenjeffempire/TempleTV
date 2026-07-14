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
 *     title: "Jesus on the Mount of Olives", // shown in PiP chrome (API 31+)
 *     isPlaying: true,               // controls play/pause button in overlay
 *     onPlayPause: ({ action }) => { // called when user taps play/pause in PiP
 *       if (action === "pause") pausePlayback();
 *       if (action === "play")  resumePlayback();
 *     },
 *   });
 *
 * PiP mode detection:
 *   Android does not propagate onPictureInPictureModeChanged to the JS thread
 *   via any standard RN API. We detect it by polling `isInPictureInPictureMode()`
 *   on every AppState change (active ↔ background). This is accurate and
 *   battery-neutral since we poll only on state-change events, not on a timer.
 *
 * Media controls:
 *   When the user taps Play or Pause inside the PiP overlay window, the native
 *   module emits "onPipAction". This hook subscribes to that event and forwards
 *   it to `onPlayPause`. The media control icon also updates via `updatePipParams`
 *   whenever `isPlaying` changes, so the button always reflects real playback state.
 *
 * Restore button (showRestoreButton = true):
 *   • Adds a bundled expand-icon action to the PiP overlay window itself.
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
  addPipActionListener,
  enterPictureInPicture,
  isPictureInPictureSupported,
  isInPictureInPictureMode,
  cancelPipRestoreNotification,
  updatePipParams,
  type PipActionEvent,
} from "../modules/expo-pip-android/src";

export interface UsePictureInPictureOptions {
  /** Numerator of the desired PiP window aspect ratio. Default: 16 (16:9 landscape). */
  aspectRatioWidth?: number;
  /** Denominator of the desired PiP window aspect ratio. Default: 9 (16:9 landscape). */
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
  /**
   * Video / broadcast title shown in the PiP window chrome on Android 12+ (API 31).
   * Falls back to "Temple TV" when not provided. Ignored on older Android versions.
   */
  title?: string;
  /**
   * Current playback state. Controls which media control icon is shown inside
   * the PiP overlay: Pause button when true, Play button when false.
   * Default: true.
   */
  isPlaying?: boolean;
  /**
   * Called when the user taps Play or Pause inside the PiP overlay window.
   * Use this to pause/resume the actual playback (e.g. call playerPauseRef.current()
   * or playerPlayRef.current() from the player context).
   */
  onPlayPause?: (event: PipActionEvent) => void;
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
    title,
    isPlaying = true,
    onPlayPause,
  } = options;

  // Track mounted state so async PiP responses (.then callbacks, AppState
  // handlers) don't call setIsInPip after the hook's consumer unmounts.
  // React 18 silently ignores post-unmount setState, but the explicit guard
  // prevents ghost state updates from clobbering state in a remounted screen.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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

  // Keep latest options in refs so callbacks don't stale-close over them
  // (avoids re-registering handlers on every option change).
  const aspectRef      = useRef({ width: aspectRatioWidth, height: aspectRatioHeight });
  const autoEnterRef   = useRef(autoEnterOnBackground);
  const showRestoreRef = useRef(showRestoreButton);
  const titleRef       = useRef(title ?? null);
  const isPlayingRef   = useRef(isPlaying);
  const onPlayPauseRef = useRef(onPlayPause);
  useEffect(() => {
    aspectRef.current      = { width: aspectRatioWidth, height: aspectRatioHeight };
    autoEnterRef.current   = autoEnterOnBackground;
    showRestoreRef.current = showRestoreButton;
    titleRef.current       = title ?? null;
    isPlayingRef.current   = isPlaying;
    onPlayPauseRef.current = onPlayPause;
  }, [aspectRatioWidth, aspectRatioHeight, autoEnterOnBackground,
      showRestoreButton, title, isPlaying, onPlayPause]);

  // ── Media-control event listener ─────────────────────────────────────────
  // Subscribe to play/pause button taps from inside the PiP overlay window.
  useEffect(() => {
    if (!isSupported) return;
    const sub = addPipActionListener((event) => {
      onPlayPauseRef.current?.(event);
    });
    return () => sub.remove();
  }, [isSupported]);

  const enterPip = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;
    const entered = await enterPictureInPicture(
      aspectRef.current.width,
      aspectRef.current.height,
      showRestoreRef.current,
      titleRef.current,
      isPlayingRef.current,
    );
    // Bug fix: update isInPip immediately when the system accepts the PiP
    // request rather than waiting for the next AppState event. Without this,
    // isInPip stays false until AppState fires, leaving PiP-hidden elements
    // (controls, countdown overlay, chat) briefly visible inside the PiP
    // window — a jarring flash on every manual PiP entry.
    // Guard with mountedRef so this never fires after the player screen unmounts.
    if (entered && mountedRef.current) setIsInPip(true);
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
      //
      // This JS-driven manual entry is the fallback for Android 8–11 (API 26–30),
      // which lack setAutoEnterEnabled. On Android 12+ (API 31+) the native
      // module arms system-driven auto-enter (see the arming effect below), so we
      // skip the manual attempt there entirely — the OS handles it more reliably
      // and a manual call would only ever be a benign redundant request.
      const apiLevel =
        typeof Platform.Version === "number"
          ? Platform.Version
          : parseInt(String(Platform.Version), 10) || 0;
      if (
        autoEnterRef.current &&
        apiLevel < 31 &&
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
          titleRef.current,
          isPlayingRef.current,
        ).then((entered) => {
          // mountedRef guard: the AppState listener is removed on cleanup, but
          // this .then() can still resolve after unmount if enterPictureInPicture
          // was already in-flight when the screen unmounted.
          if (entered && mountedRef.current) setIsInPip(true);
        }).catch(() => {});
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [isSupported]);

  // ── Arm modern system-driven automatic PiP (Android 12 / API 31+) ────────
  // setPictureInPictureParams(setAutoEnterEnabled(true)) lets the OS itself
  // enter PiP the instant the activity is backgrounded while a video plays —
  // the same mechanism YouTube uses. It is far more reliable than the
  // AppState-driven manual entry above, which races the background transition
  // and is frequently rejected by the system on modern Android. Below API 31
  // this is a native no-op and the AppState fallback handles auto-enter.
  //
  // We re-arm whenever any PiP param changes so the system always uses the
  // correct window shape, title, and media control state, and we DISARM on
  // cleanup so PiP never triggers from an unrelated screen after this unmounts.
  useEffect(() => {
    if (!isSupported || !autoEnterOnBackground) return;
    void updatePipParams(
      aspectRatioWidth,
      aspectRatioHeight,
      showRestoreButton,
      true,
      title ?? null,
      isPlaying,
    );
    return () => {
      void updatePipParams(
        aspectRatioWidth,
        aspectRatioHeight,
        showRestoreButton,
        false,
        title ?? null,
        isPlaying,
      );
    };
  }, [
    isSupported,
    autoEnterOnBackground,
    aspectRatioWidth,
    aspectRatioHeight,
    showRestoreButton,
    title,
    isPlaying,
  ]);

  // ── Keep PiP media controls in sync with playback state ──────────────────
  // When the user is already in PiP and playback transitions play ↔ pause,
  // update the overlay's media control button icon without re-entering PiP.
  // `updatePipParams` is a no-op when autoEnterOnBackground is true (the
  // effect above handles it) — this effect covers the manual-entry path.
  useEffect(() => {
    if (!isSupported || autoEnterOnBackground) return;
    if (!isInPictureInPictureMode()) return;
    void updatePipParams(
      aspectRatioWidth,
      aspectRatioHeight,
      showRestoreButton,
      false,
      title ?? null,
      isPlaying,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  return { isSupported, isInPip, enterPip };
}
