import React, { useCallback } from "react";
import { router } from "expo-router";
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
 * Wrapper around `<V2PlayerContainer/>` that handles FATAL navigation and
 * wires PiP teardown. The v2 container owns its own transport, FSM, and
 * source resolution; the extra props are accepted for call-site compat.
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

  const handleFatal = useCallback(() => {
    if (isInPictureInPictureMode()) {
      cancelPipRestoreNotification().catch(() => {});
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
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
