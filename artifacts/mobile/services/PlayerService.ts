/**
 * RNTP PlaybackService — event bridge between the native lock-screen / notification
 * media controls and the JS player state.
 *
 * ⚠️  NO top-level static import of react-native-track-player here.
 *
 * Why: PlayerContext.tsx has a top-level `import { setBroadcastModeForRemoteHandlers }
 * from "@/services/PlayerService"`. Because it is a static import, Metro evaluates
 * this module at cold-start, before _layout.tsx has called `setupTrackPlayer()`.
 * With New Architecture enabled (`newArchEnabled: true`), RNTP's TurboModule must
 * be registered before its JS module is accessed — a top-level import that runs
 * before registration causes a hard crash on Android/iOS startup.
 *
 * Fix: lazy-require react-native-track-player inside PlaybackService(). By the time
 * that function is invoked, RNTP's native side has already registered its TurboModule
 * (it is called by the native side only after `TrackPlayer.registerPlaybackService`
 * completed setup). This is consistent with the pattern in `services/nowPlaying.ts`.
 */

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
 * Module-level broadcast-mode flag mirrored from PlayerContext.
 * The PlaybackService callbacks fire from the native side outside of any React
 * lifecycle, so we cannot read context here. When `true`, RemoteSeek /
 * RemoteNext / RemotePrevious become no-ops — even if a stale lock-screen UI
 * exposes those buttons, tapping them will not advance or scrub the channel feed.
 */
let broadcastMode = false;

export function setBroadcastModeForRemoteHandlers(b: boolean) {
  broadcastMode = b;
}

export function setTrackPlayerRemoteHandlers(h: RemoteEventHandlers) {
  handlers = h;
}

export async function PlaybackService() {
  // Lazy-require RNTP here — safe because by the time PlaybackService() is
  // invoked by the native RNTP runtime, the TurboModule is fully registered.
  // Using require() (synchronous) rather than dynamic import() because this
  // function is called synchronously from native and must register all listeners
  // before returning.
  interface RNTrackPlayerModule {
    addEventListener(event: string, listener: () => Promise<void> | void): void;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seekTo(seconds: number): Promise<void>;
  }
  let TrackPlayer: RNTrackPlayerModule | undefined;
  let Event: Record<string, string> | undefined;
  try {
    const mod = require("react-native-track-player");
    TrackPlayer = mod.default ?? mod;
    Event = mod.Event;
  } catch {
    // RNTP not available (e.g. running on web, or native module not linked).
    // Graceful degradation — no lock-screen controls, but playback still works.
    return;
  }

  if (!TrackPlayer || !Event) return;

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

  TrackPlayer.addEventListener(Event.RemoteSeek, async (event: { position: number }) => {
    if (broadcastMode) return;
    await TrackPlayer.seekTo(event.position);
    handlers.onSeek?.(event.position);
  });

  TrackPlayer.addEventListener(Event.RemoteDuck, async (event: { permanent: boolean; paused: boolean }) => {
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
