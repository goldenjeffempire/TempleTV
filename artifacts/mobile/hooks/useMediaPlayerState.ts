/**
 * useMediaPlayerState — global media player state machine
 *
 * Single source of truth for the current media playback state across all
 * surfaces (home hero, player screen, mini player, channels). Reads from:
 *   • useNetworkContext — device online/offline
 *   • useV2BroadcastNative — V2 broadcast FSM snapshot
 *   • usePlayer — VOD / live-YouTube session state
 *
 * Exposed state:
 *   idle         — nothing is playing, nothing is loading
 *   loading      — stream is bootstrapping or preparing the first buffer
 *   live         — stream is actively playing (PLAYING state in FSM)
 *   reconnecting — FSM is recovering after a brief drop
 *   offline      — device has no network connectivity
 *   error        — FSM reached FATAL and cannot self-recover
 *
 * CTA logic:
 *   isWatchLiveCTAVisible — true in idle / offline / error states;
 *     the "Watch Live" button should only appear when the user is NOT
 *     already watching. In `live` state the hero transitions to a
 *     "Now Playing" indicator instead.
 *
 *   isAlreadyLive — convenience flag: mediaState === 'live'. Use to
 *     switch the hero CTA to an "Open Player" affordance.
 */

import { useMemo } from "react";
import { useNetworkContext } from "@/context/NetworkContext";
import { usePlayer } from "@/context/PlayerContext";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import { getApiBase } from "@/lib/apiBase";

// V2 FSM state names as produced by the player-core machine.
// Keep in sync with lib/player-core/src/machine.ts StateValue enum.
const LOADING_STATES = new Set([
  "BOOTSTRAP",
  "PREPARING_ACTIVE",
  "SKIP_PENDING",
]);
const PLAYING_STATES = new Set(["PLAYING"]);
const RECOVERING_STATES = new Set([
  "RECOVERING_PRIMARY",
  "RECOVERING_FAILOVER",
]);
const ERROR_STATES = new Set(["FATAL"]);

export type MediaState =
  | "idle"
  | "loading"
  | "live"
  | "reconnecting"
  | "offline"
  | "error";

export interface MediaPlayerState {
  /** The canonical unified state */
  mediaState: MediaState;

  /**
   * Show a "Watch Live" / "Tune In" CTA.
   * True when the user is NOT actively watching the broadcast.
   */
  isWatchLiveCTAVisible: boolean;

  /**
   * The broadcast is currently playing — transition hero CTA to
   * "Open Player" / "Now Watching" mode.
   */
  isAlreadyLive: boolean;

  /**
   * User's device has no network connectivity. Show offline UI.
   */
  isOffline: boolean;

  /**
   * The stream is recovering after a brief connectivity drop.
   * Show a soft reconnecting indicator rather than a hard error.
   */
  isReconnecting: boolean;

  /**
   * The broadcast FSM reached an unrecoverable FATAL state.
   * Show an error state with a retry prompt.
   */
  isFatal: boolean;

  /**
   * The broadcast FSM is actively in PLAYING. Does NOT include
   * recovering/loading — use `mediaState === 'live'` for strict live check.
   */
  isBroadcastPlaying: boolean;

  /**
   * Raw FSM state string from the player-core snapshot.
   * Use only for debugging / telemetry; prefer `mediaState` for UI logic.
   */
  fsmState: string | null;

  /**
   * Title of the currently airing item, or null.
   * Works for both broadcast and VOD modes.
   */
  currentTitle: string | null;

  /**
   * Thumbnail URL of the currently airing item, or null.
   */
  currentThumbnailUrl: string | null;
}

export function useMediaPlayerState(): MediaPlayerState {
  const { isOnline } = useNetworkContext();
  const { isLive, isBroadcastMode, currentSermon } = usePlayer();

  const apiBase = getApiBase() ?? "";
  const { snapshot } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });

  return useMemo((): MediaPlayerState => {
    const lastSnapshot = snapshot.lastServerSnapshot;
    const rawFsmState = snapshot.state ?? null;

    // Device offline always wins — no matter what the FSM thinks.
    if (!isOnline) {
      return {
        mediaState: "offline",
        isWatchLiveCTAVisible: true,
        isAlreadyLive: false,
        isOffline: true,
        isReconnecting: false,
        isFatal: false,
        isBroadcastPlaying: false,
        fsmState: rawFsmState,
        currentTitle: lastSnapshot?.current?.title ?? currentSermon?.title ?? null,
        currentThumbnailUrl:
          lastSnapshot?.current?.thumbnailUrl ??
          currentSermon?.thumbnailUrl ??
          null,
      };
    }

    const fsmState = rawFsmState ?? "BOOTSTRAP";

    let mediaState: MediaState;

    if (ERROR_STATES.has(fsmState)) {
      mediaState = "error";
    } else if (RECOVERING_STATES.has(fsmState)) {
      mediaState = "reconnecting";
    } else if (PLAYING_STATES.has(fsmState)) {
      mediaState = "live";
    } else if (LOADING_STATES.has(fsmState)) {
      // If the FSM is loading but nothing is queued (empty channel), treat as idle.
      const hasItem = !!lastSnapshot?.current;
      mediaState = hasItem ? "loading" : "idle";
    } else {
      // IDLE, unknown, or no snapshot yet
      mediaState = "idle";
    }

    const isBroadcastPlaying = mediaState === "live";
    const isAlreadyLive = isBroadcastPlaying || isLive;

    // CTA is visible when we are not already watching the broadcast.
    const isWatchLiveCTAVisible =
      mediaState === "idle" ||
      mediaState === "error";

    const currentTitle =
      lastSnapshot?.current?.title ??
      currentSermon?.title ??
      (isLive ? "Live" : null);

    const currentThumbnailUrl =
      lastSnapshot?.current?.thumbnailUrl ??
      currentSermon?.thumbnailUrl ??
      null;

    return {
      mediaState,
      isWatchLiveCTAVisible,
      isAlreadyLive,
      isOffline: false,
      isReconnecting: mediaState === "reconnecting",
      isFatal: mediaState === "error",
      isBroadcastPlaying,
      fsmState: rawFsmState,
      currentTitle,
      currentThumbnailUrl,
    };
  }, [isOnline, snapshot, isLive, isBroadcastMode, currentSermon]);
}
