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
    addEventListener(
      event: string,
      listener: (eventData?: Record<string, unknown>) => Promise<void> | void,
    ): void;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seekTo(seconds: number): Promise<void>;
  }
  interface RNTPEvent {
    RemotePlay: string;
    RemotePause: string;
    RemoteStop: string;
    RemoteNext: string;
    RemotePrevious: string;
    RemoteSeek: string;
    RemoteDuck: string;
  }
  let TrackPlayer: RNTrackPlayerModule | undefined;
  let Event: RNTPEvent | undefined;
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

  // Capture non-null references for use inside async callbacks.
  const tp = TrackPlayer;
  const evt = Event;

  tp.addEventListener(evt.RemotePlay, async () => {
    await tp.play();
    handlers.onPlay?.();
  });

  tp.addEventListener(evt.RemotePause, async () => {
    await tp.pause();
    handlers.onPause?.();
  });

  tp.addEventListener(evt.RemoteStop, async () => {
    await tp.stop();
    handlers.onStop?.();
  });

  tp.addEventListener(evt.RemoteNext, () => {
    if (broadcastMode) return;
    handlers.onNext?.();
  });

  tp.addEventListener(evt.RemotePrevious, () => {
    if (broadcastMode) return;
    handlers.onPrevious?.();
  });

  tp.addEventListener(evt.RemoteSeek, async (rawEvent?: Record<string, unknown>) => {
    if (broadcastMode) return;
    const position = typeof rawEvent?.position === "number" ? rawEvent.position : 0;
    await tp.seekTo(position);
    handlers.onSeek?.(position);
  });

  tp.addEventListener(evt.RemoteDuck, async (rawEvent?: Record<string, unknown>) => {
    const permanent = rawEvent?.permanent === true;
    const paused = rawEvent?.paused === true;
    if (permanent) {
      await tp.pause();
      handlers.onPause?.();
    } else if (paused) {
      await tp.pause();
    } else {
      await tp.play();
    }
  });
}
