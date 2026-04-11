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
    handlers.onNext?.();
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    handlers.onPrevious?.();
  });

  TrackPlayer.addEventListener(Event.RemoteSeek, async (event) => {
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
