import { Platform } from "react-native";

let TrackPlayer: typeof import("react-native-track-player").default | null = null;
let Capability: typeof import("react-native-track-player").Capability | null = null;
let AppKilledPlaybackBehavior: typeof import("react-native-track-player").AppKilledPlaybackBehavior | null = null;
let State: typeof import("react-native-track-player").State | null = null;

let isSetup = false;

async function loadRNTP() {
  if (TrackPlayer) return true;
  try {
    const mod = await import("react-native-track-player");
    TrackPlayer = mod.default;
    Capability = mod.Capability as any;
    AppKilledPlaybackBehavior = mod.AppKilledPlaybackBehavior as any;
    State = mod.State as any;
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
  } catch (err) {
    console.warn("[nowPlaying] setupPlayer failed:", err);
  }
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
    console.warn("[nowPlaying] loadAndPlayTrack failed:", err);
  }
}

export async function resumeTrackPlayer(): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.play();
  } catch {}
}

export async function pauseTrackPlayer(): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.pause();
  } catch {}
}

export async function seekTrackPlayer(positionSecs: number): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.seekTo(positionSecs);
  } catch {}
}

export async function stopTrackPlayer(): Promise<void> {
  if (!isSetup || Platform.OS === "web" || !TrackPlayer) return;
  try {
    await TrackPlayer.reset();
  } catch {}
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
