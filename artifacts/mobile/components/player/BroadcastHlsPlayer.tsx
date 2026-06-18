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
