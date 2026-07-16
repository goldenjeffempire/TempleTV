import React, { useCallback } from "react";
import { V2PlayerContainer } from "@/components/V2PlayerContainer";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getApiBase } from "@/lib/apiBase";
import {
  cancelPipRestoreNotification,
  isInPictureInPictureMode,
} from "@/modules/expo-pip-android/src";

export interface BroadcastHlsPlayerProps {
  initialUrl:           string;
  initialPositionMs:    number;
  thumbnailUrl:         string;
  title:                string;
  playerHeightOverride: number;
  onProgress?:          (positionSecs: number, durationSecs: number) => void;
  /**
   * When true, forces the underlying A/B video buffers to be muted even if
   * the FSM has designated one as active. Used by the inline (non-fullscreen)
   * instance to suppress audio bleed while the fullscreen Modal player loads.
   */
  muted?:               boolean;
  /**
   * When true, all FSM buffer event reporting and watchdog arming are
   * suppressed. Use on the inline (muted) player instance while the fullscreen
   * Modal player is active — both share the same singleton session/FSM.
   */
  suppressEvents?:      boolean;
  /**
   * Reactive PiP-mode flag forwarded to V2PlayerContainer so its
   * YouTube-override-in-PiP exit becomes reactive to PiP entry.
   */
  isInPip?:             boolean;
}

/**
 * Wrapper around `<V2PlayerContainer/>` that handles PiP teardown.
 *
 * The v2 container owns its own transport, FSM, and source resolution;
 * the extra props (initialUrl, initialPositionMs, thumbnailUrl, title,
 * playerHeightOverride, onProgress) are accepted for call-site compat
 * but intentionally discarded — the V2 engine resolves all of these
 * from its own WS snapshot.
 *
 * IMPORTANT — onFatal design:
 *   onFatal is passed to V2PlayerContainer as a PiP-cleanup hook only.
 *   It MUST NOT call router.back() or router.replace().
 *
 *   The old behaviour (auto-navigate back on FATAL) caused a critical UX
 *   regression: when the player opens and the WS transport fails (no API
 *   URL set, transient network error, connection refused), the FSM
 *   transitions to FATAL almost immediately.  With router.back() in
 *   handleFatal the player screen was opening and closing in < 300 ms —
 *   indistinguishable to the user from "the button doesn't work at all."
 *
 *   V2PlayerContainer already shows a "Playback Error" overlay with a
 *   countdown timer and a manual Retry button for FATAL state.  Closing
 *   the screen automatically removes that recovery path entirely.  The
 *   user should stay on the player screen and use its own back button
 *   (always visible in the page header) or the Retry button to recover.
 */
export function BroadcastHlsPlayer({ muted, suppressEvents, isInPip, ...rest }: BroadcastHlsPlayerProps) {
  void rest;
  const apiBase = getApiBase() ?? "";

  // ── Dev-mode guard: warn if apiBase is missing or relative ─────────────────
  // A missing or relative baseUrl causes the WS transport to construct an
  // invalid URL (e.g. ws:///api/broadcast-v2/ws on native) and silently fail
  // at connection time — the FSM stays in BOOTSTRAP forever and the player
  // shows "Connecting…" indefinitely. The fix is EXPO_PUBLIC_API_URL in
  // .env.local (dev) / .env.production (prod). This log makes the root cause
  // immediately obvious in the Expo console instead of requiring a trace.
  if (__DEV__ && (!apiBase || apiBase.startsWith("/"))) {
    console.error(
      "[BroadcastHlsPlayer] apiBase is missing or relative:",
      JSON.stringify(apiBase),
      "— set EXPO_PUBLIC_API_URL in artifacts/mobile/.env.local for dev builds.",
      "WS transport will fail to connect; player will stay at BOOTSTRAP.",
    );
  } else if (__DEV__) {
    console.log("[BroadcastHlsPlayer] mounting, baseUrl:", `${apiBase}/api/broadcast-v2`);
  }

  /**
   * Called by V2PlayerContainer when the FSM enters FATAL state.
   *
   * Responsibilities:
   *   1. Cancel any active PiP restore notification so the system-level
   *      "Return to broadcast" pill doesn't linger after the FSM fails.
   *
   * Explicitly NOT responsible for:
   *   • Navigating back / closing the player — V2PlayerContainer already
   *     renders a "Playback Error" overlay with countdown + Retry.  Auto-
   *     closing would silently remove that recovery path and make the
   *     "Open Player" button appear completely non-functional whenever the
   *     API is temporarily unreachable.
   */
  const handleFatal = useCallback(() => {
    if (isInPictureInPictureMode()) {
      cancelPipRestoreNotification().catch(() => {});
    }
    if (__DEV__) {
      console.warn(
        "[BroadcastHlsPlayer] handleFatal: FSM entered FATAL.",
        "V2PlayerContainer will show the error overlay with retry.",
        "The player screen stays open — user can tap Retry or the back button.",
      );
    }
    // Do NOT call router.back() or router.replace() here.
    // See the component-level JSDoc above for the full rationale.
  }, []);

  return (
    <ErrorBoundary>
      <V2PlayerContainer
        baseUrl={`${apiBase}/api/broadcast-v2`}
        onFatal={handleFatal}
        muted={muted}
        suppressEvents={suppressEvents}
        isInPip={isInPip}
      />
    </ErrorBoundary>
  );
}
