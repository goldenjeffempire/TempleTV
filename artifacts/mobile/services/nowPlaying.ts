import { Platform } from "react-native";

let TrackPlayer: typeof import("react-native-track-player").default | null = null;
let Capability: typeof import("react-native-track-player").Capability | null = null;
let AppKilledPlaybackBehavior: typeof import("react-native-track-player").AppKilledPlaybackBehavior | null = null;
let State: typeof import("react-native-track-player").State | null = null;

let isSetup = false;

function isNativeRNTPCapable(): boolean {
  // Default-DENY. RNTP's JS shim eagerly reads CAPABILITY_PLAY off the native
  // TurboModule during module init. In Expo Go the native module is null and
  // the read throws "Cannot read property 'CAPABILITY_PLAY' of null" — an
  // uncatchable Hermes error that escapes even our try/catch wrapper. Only
  // load RNTP when we can positively confirm we're in a dev-client /
  // standalone / bare build AND the native module is actually registered.
  if (Platform.OS === "web") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ConstantsModule = require("expo-constants");
    const Constants = ConstantsModule?.default ?? ConstantsModule;
    const env: unknown = Constants?.executionEnvironment;
    const ownership: unknown = Constants?.appOwnership;
    const isNativeBuild =
      env === "standalone" || env === "bare" || ownership === "standalone";
    if (!isNativeBuild) return false;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NativeModules } = require("react-native");
    return Boolean(NativeModules?.TrackPlayerModule);
  } catch {
    return false;
  }
}

async function loadRNTP() {
  if (TrackPlayer) return true;
  if (!isNativeRNTPCapable()) return false;
  try {
    const mod = await import("react-native-track-player");
    TrackPlayer = mod.default;
    Capability = mod.Capability;
    AppKilledPlaybackBehavior = mod.AppKilledPlaybackBehavior;
    State = mod.State;
    return true;
  } catch {
    return false;
  }
}

export async function setupTrackPlayer(): Promise<void> {
  if (Platform.OS === "web" || isSetup) return;
  const ok = await loadRNTP();
  if (!ok || !TrackPlayer || !Capability || !AppKilledPlaybackBehavior) return;

  try {
    await TrackPlayer.setupPlayer({
      minBuffer: 5,
      maxBuffer: 50,
      backBuffer: 10,
      waitForBuffer: true,
    });

    await TrackPlayer.updateOptions({
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
      compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
    });

    isSetup = true;

    // Round 6 (Pass 4): if broadcast mode was requested before RNTP
    // finished setting up (race between PlayerContext mounting and
    // _layout.tsx's async setupTrackPlayer call), apply the queued
    // mode now — otherwise the lock-screen/notification UI would keep
    // its default seek/skip capabilities until the next mode flip.
    if (lastBroadcastMode !== null) {
      await applyBroadcastCapabilities(lastBroadcastMode);
    }
  } catch (err) {
    if (__DEV__) console.warn("[nowPlaying] setupPlayer failed:", err);
  }
}

/**
 * Round 6 (Pass 4): the actual `updateOptions` call. Split out from
 * `setBroadcastCapabilities` so `setupPlayer` can replay the last
 * requested mode after setup completes (see lastBroadcastMode below).
 */
async function applyBroadcastCapabilities(broadcast: boolean): Promise<void> {
  if (!TrackPlayer || !Capability) return;
  try {
    if (broadcast) {
      await TrackPlayer.updateOptions({
        capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
        compactCapabilities: [Capability.Play, Capability.Pause],
        notificationCapabilities: [Capability.Play, Capability.Pause, Capability.Stop],
      });
    } else {
      await TrackPlayer.updateOptions({
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.Stop,
          Capability.SeekTo,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
        notificationCapabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.Stop,
          Capability.SeekTo,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
        ],
      });
    }
  } catch (err) {
    if (__DEV__) console.warn("[nowPlaying] applyBroadcastCapabilities failed:", err);
  }
}

/**
 * Round 6 (Pass 3 + 4): swap the system-level media controls (lock screen,
 * notification shade, Bluetooth headset, Auto/CarPlay) to match channel
 * semantics. While in broadcast mode we expose only Play/Pause/Stop —
 * SeekTo and SkipToNext/SkipToPrevious are removed so a user cannot
 * scrub or skip the current program from outside the app. Pass 4: if
 * RNTP isn't set up yet (called during the cold-start race), the desired
 * mode is recorded and replayed once setupPlayer completes.
 */
let lastBroadcastMode: boolean | null = null;

export async function setBroadcastCapabilities(broadcast: boolean): Promise<void> {
  if (Platform.OS === "web") return;
  lastBroadcastMode = broadcast;
  if (!isSetup) return;
  await applyBroadcastCapabilities(broadcast);
}

export interface NowPlayingTrack {
  id: string;
  url: string;
  title: string;
  artist?: string;
  artwork?: string;
  duration?: number;
  isLiveStream?: boolean;
}

export async function loadAndPlayTrack(track: NowPlayingTrack): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.reset();
    await TrackPlayer.add({
      id: track.id,
      url: track.url,
      title: track.title,
      artist: track.artist ?? "Temple TV JCTM",
      artwork: track.artwork,
      duration: track.duration,
      isLiveStream: track.isLiveStream ?? false,
    });
    await TrackPlayer.play();
  } catch (err) {
    if (__DEV__) console.warn("[nowPlaying] loadAndPlayTrack failed:", err);
  }
}

export async function resumeTrackPlayer(): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.play();
  } catch (err) {
    if (__DEV__) console.warn("[nowPlaying] resumeTrackPlayer failed:", err);
  }
}

export async function pauseTrackPlayer(): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.pause();
  } catch (err) {
    if (__DEV__) console.warn("[nowPlaying] pauseTrackPlayer failed:", err);
  }
}

export async function seekTrackPlayer(positionSecs: number): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.seekTo(positionSecs);
  } catch (err) {
    if (__DEV__) console.warn("[nowPlaying] seekTrackPlayer failed:", err);
  }
}

export async function stopTrackPlayer(): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.reset();
  } catch (err) {
    if (__DEV__) console.warn("[nowPlaying] stopTrackPlayer failed:", err);
  }
}

export async function updateTrackPlayerMetadata(info: {
  title: string;
  artist?: string;
  artwork?: string;
  duration?: number;
}): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.updateNowPlayingMetadata({
      title: info.title,
      artist: info.artist ?? "Temple TV JCTM",
      artwork: info.artwork,
      duration: info.duration,
    });
  } catch {}
}

export function isTrackPlayerSetup(): boolean {
  return isSetup;
}
