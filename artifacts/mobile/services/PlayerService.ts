import TrackPlayer, { Event } from "react-native-track-player";

type RemoteEventHandlers = {
  onPlay?: () => void;
  onPause?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onSeek?: (positionSecs: number) => void;
  onStop?: () => void;
};

let handlers: RemoteEventHandlers = {};

/**
 * Round 6 (Pass 3): module-level broadcast-mode flag mirrored from
 * PlayerContext. The PlaybackService callbacks fire from the native
 * side outside of any React lifecycle, so we cannot read context here.
 * When `true`, RemoteSeek/RemoteNext/RemotePrevious become no-ops —
 * even if a stale lock-screen UI exposes those buttons (e.g. a Bluetooth
 * headset that caches the previous capability set), tapping them will
 * not advance or scrub the channel feed.
 */
let broadcastMode = false;

export function setBroadcastModeForRemoteHandlers(b: boolean) {
  broadcastMode = b;
}

export function setTrackPlayerRemoteHandlers(h: RemoteEventHandlers) {
  handlers = h;
}

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    await TrackPlayer.play();
    handlers.onPlay?.();
  });

  TrackPlayer.addEventListener(Event.RemotePause, async () => {
    await TrackPlayer.pause();
    handlers.onPause?.();
  });

  TrackPlayer.addEventListener(Event.RemoteStop, async () => {
    await TrackPlayer.stop();
    handlers.onStop?.();
  });

  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    if (broadcastMode) return;
    handlers.onNext?.();
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    if (broadcastMode) return;
    handlers.onPrevious?.();
  });

  TrackPlayer.addEventListener(Event.RemoteSeek, async (event) => {
    if (broadcastMode) return;
    await TrackPlayer.seekTo(event.position);
    handlers.onSeek?.(event.position);
  });

  TrackPlayer.addEventListener(Event.RemoteDuck, async (event) => {
    if (event.permanent) {
      await TrackPlayer.pause();
      handlers.onPause?.();
    } else if (event.paused) {
      await TrackPlayer.pause();
    } else {
      await TrackPlayer.play();
    }
  });
}
