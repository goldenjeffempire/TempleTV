import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LoopMode, Sermon } from "@/types";
import { STORAGE_KEYS } from "@/constants/config";
import { stopTrackPlayer, setBroadcastCapabilities } from "@/services/nowPlaying";
import { setBroadcastModeForRemoteHandlers } from "@/services/PlayerService";
import * as audioController from "@/services/audioController";

interface PlayerContextType {
  currentSermon: Sermon | null;
  nextSermon: Sermon | null;
  isPlaying: boolean;
  isRadioMode: boolean;
  isLive: boolean;
  /**
   * Round 6: true while the user is watching the broadcast queue (a
   * station-driven continuous channel feed), independent of `isLive`
   * which is reserved for actual YouTube live streams. Surfaces such
   * as the MiniPlayer use this to suppress the playback progress bar
   * — broadcast surfaces never show a position indicator.
   */
  isBroadcastMode: boolean;
  queue: Sermon[];
  currentIndex: number;
  dataSaver: boolean;
  shuffleMode: boolean;
  loopMode: LoopMode;
  volume: number;
  playSermon: (sermon: Sermon, newQueue?: Sermon[]) => void;
  playLive: () => void;
  togglePlay: () => void;
  toggleRadioMode: () => void;
  toggleDataSaver: () => void;
  toggleShuffle: () => void;
  cycleLoopMode: () => void;
  playNext: () => void;
  playPrevious: () => void;
  advanceToNext: () => void;
  setQueue: (sermons: Sermon[]) => void;
  stopPlayback: () => void;
  setVolume: (v: number) => void;
  seekTo: (time: number) => void;
  updatePlayback: (time: number, duration: number) => void;
  /**
   * Round 6: imperative setter the player route uses to enter/leave
   * broadcast mode as the user opens/closes the broadcast viewer.
   * Mirrors the existing `setQueue`-style imperative API.
   */
  setIsBroadcastMode: (b: boolean) => void;
  playerPlayRef: React.MutableRefObject<(() => void) | null>;
  playerPauseRef: React.MutableRefObject<(() => void) | null>;
  playerSeekRef: React.MutableRefObject<((t: number) => void) | null>;
  playerVolumeRef: React.MutableRefObject<((v: number) => void) | null>;
}

interface PlayerProgressContextType {
  currentTime: number;
  duration: number;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);
const PlayerProgressContext = createContext<PlayerProgressContextType>({ currentTime: 0, duration: 0 });

const LOOP_CYCLE: LoopMode[] = ["none", "all", "one"];

interface PersistedPlaybackSettings {
  dataSaver?: boolean;
  isRadioMode?: boolean;
  shuffleMode?: boolean;
  loopMode?: LoopMode;
  volume?: number;
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildShuffledQueue(sermons: Sermon[], startId?: string): Sermon[] {
  const shuffled = fisherYatesShuffle(sermons);
  if (startId) {
    const idx = shuffled.findIndex((s) => s.youtubeId === startId);
    if (idx > 0) {
      const [item] = shuffled.splice(idx, 1);
      if (item) shuffled.unshift(item);
    }
  }
  return shuffled;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentSermon, setCurrentSermon] = useState<Sermon | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRadioMode, setIsRadioMode] = useState(false);
  const [isLive, setIsLive] = useState(false);
  // Round 6: see PlayerContextType for rationale. Persisted only in memory;
  // the player route flips it on mount/unmount of broadcast playback.
  const [isBroadcastMode, setIsBroadcastMode] = useState(false);

  // Round 6 (Pass 3): keep the system-level media controls (lock screen,
  // notification shade, Bluetooth/CarPlay) in sync with broadcast mode.
  // Both calls are no-ops on web and gracefully degrade if RNTP hasn't
  // finished setup, so this effect is safe to fire on every flip.
  useEffect(() => {
    setBroadcastModeForRemoteHandlers(isBroadcastMode);
    setBroadcastCapabilities(isBroadcastMode).catch(() => {});
  }, [isBroadcastMode]);
  const [queue, setQueueState] = useState<Sermon[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [dataSaver, setDataSaver] = useState(false);
  const [shuffleMode, setShuffleMode] = useState(false);
  const [loopMode, setLoopMode] = useState<LoopMode>("all");
  const [shuffledQueue, setShuffledQueue] = useState<Sermon[]>(() =>
    buildShuffledQueue([]),
  );
  const [shufflePosition, setShufflePosition] = useState(0);
  const [volume, setVolumeState] = useState(100);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const loadedSettingsRef = useRef(false);

  const playerPlayRef = useRef<(() => void) | null>(null);
  const playerPauseRef = useRef<(() => void) | null>(null);
  const playerSeekRef = useRef<((t: number) => void) | null>(null);
  const playerVolumeRef = useRef<((v: number) => void) | null>(null);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const shuffleRef = useRef(shuffleMode);
  shuffleRef.current = shuffleMode;
  const loopRef = useRef(loopMode);
  loopRef.current = loopMode;
  const shuffledQueueRef = useRef(shuffledQueue);
  shuffledQueueRef.current = shuffledQueue;
  const shufflePosRef = useRef(shufflePosition);
  shufflePosRef.current = shufflePosition;
  const currentSermonRef = useRef(currentSermon);
  currentSermonRef.current = currentSermon;
  // Round 6 (Pass 4): keep a ref mirror of broadcast mode so callbacks
  // captured with empty dep arrays (playNext / playPrevious) can read
  // the current value without forcing a re-creation of the callback.
  const isBroadcastModeRef = useRef(isBroadcastMode);
  isBroadcastModeRef.current = isBroadcastMode;

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEYS.playbackSettings)
      .then((raw) => {
        if (!mounted || !raw) return;
        const parsed = JSON.parse(raw) as PersistedPlaybackSettings;
        if (typeof parsed.dataSaver === "boolean") setDataSaver(parsed.dataSaver);
        if (typeof parsed.isRadioMode === "boolean") setIsRadioMode(parsed.isRadioMode);
        if (typeof parsed.shuffleMode === "boolean") setShuffleMode(parsed.shuffleMode);
        if (parsed.loopMode && LOOP_CYCLE.includes(parsed.loopMode)) setLoopMode(parsed.loopMode);
        if (typeof parsed.volume === "number") setVolumeState(Math.max(0, Math.min(100, parsed.volume)));
      })
      .catch(() => {})
      .finally(() => {
        loadedSettingsRef.current = true;
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!loadedSettingsRef.current) return;
    const payload: PersistedPlaybackSettings = {
      dataSaver,
      isRadioMode,
      shuffleMode,
      loopMode,
      volume,
    };
    AsyncStorage.setItem(STORAGE_KEYS.playbackSettings, JSON.stringify(payload)).catch(() => {});
  }, [dataSaver, isRadioMode, shuffleMode, loopMode, volume]);

  useEffect(() => {
    if (shuffleMode) {
      const rebuilt = buildShuffledQueue(queue, currentSermon?.youtubeId);
      setShuffledQueue(rebuilt);
      const pos = rebuilt.findIndex((s) => s.youtubeId === currentSermon?.youtubeId);
      setShufflePosition(pos >= 0 ? pos : 0);
    }
  }, [queue]);

  const nextSermon = useMemo((): Sermon | null => {
    if (isLive || !currentSermon) return null;
    if (loopMode === "one") return currentSermon;

    if (shuffleMode) {
      const sq = shuffledQueue;
      const pos = shufflePosition;
      const nextPos = pos + 1;
      if (nextPos >= sq.length) {
        return loopMode === "none" ? null : (sq[0] ?? null);
      }
      return sq[nextPos] ?? null;
    } else {
      const nextIdx = currentIndex + 1;
      if (nextIdx >= queue.length) {
        return loopMode === "none" ? null : (queue[0] ?? null);
      }
      return queue[nextIdx] ?? null;
    }
  }, [
    currentSermon,
    currentIndex,
    shuffleMode,
    shufflePosition,
    shuffledQueue,
    queue,
    loopMode,
    isLive,
  ]);

  const playSermon = useCallback((sermon: Sermon, newQueue?: Sermon[]) => {
    // Stop radio before starting VOD — single audio lane enforced here.
    audioController.requestRadioStop();

    const q = newQueue ?? queueRef.current;
    if (newQueue) {
      setQueueState(newQueue);
      queueRef.current = newQueue;
    }

    setCurrentSermon(sermon);
    setIsPlaying(true);
    setIsLive(false);
    // Round 6 (Pass 3): an explicit VOD pick exits broadcast mode. The
    // user has chosen a specific sermon to play, so the channel feed is
    // no longer what's on the screen — surfaces like MiniPlayer should
    // re-enable VOD chrome (progress bar, skip-forward).
    setIsBroadcastMode(false);
    setCurrentTime(0);
    setDuration(0);

    const idx = q.findIndex((s) => s.id === sermon.id);
    if (idx >= 0) setCurrentIndex(idx);

    if (shuffleRef.current) {
      const sq = buildShuffledQueue(q, sermon.youtubeId);
      setShuffledQueue(sq);
      setShufflePosition(0);
    }
  }, []);

  const playLive = useCallback(() => {
    // Stop radio before starting a live broadcast — single audio lane.
    audioController.requestRadioStop();
    setIsLive(true);
    setIsPlaying(true);
    // Round 6 (Pass 3): playing the actual YouTube live feed exits
    // broadcast-queue mode (the two are mutually exclusive — one is a
    // YT live stream, the other is a synthesized continuous channel).
    setIsBroadcastMode(false);
    setCurrentSermon(null);
    setCurrentTime(0);
    setDuration(0);
  }, []);

  const togglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      const next = !prev;
      if (next) {
        playerPlayRef.current?.();
      } else {
        playerPauseRef.current?.();
      }
      return next;
    });
  }, []);

  const toggleRadioMode = useCallback(() => {
    setIsRadioMode((prev) => !prev);
  }, []);

  const toggleDataSaver = useCallback(() => {
    setDataSaver((prev) => !prev);
  }, []);

  const toggleShuffle = useCallback(() => {
    setShuffleMode((prev) => {
      const next = !prev;
      if (next) {
        const rebuilt = buildShuffledQueue(queueRef.current, currentSermonRef.current?.youtubeId);
        setShuffledQueue(rebuilt);
        setShufflePosition(0);
      }
      return next;
    });
  }, []);

  const cycleLoopMode = useCallback(() => {
    setLoopMode((prev) => {
      const idx = LOOP_CYCLE.indexOf(prev);
      return LOOP_CYCLE[(idx + 1) % LOOP_CYCLE.length]!;
    });
  }, []);

  const playNext = useCallback(() => {
    // Round 6 (Pass 4): broadcast advance is handled exclusively by
    // /player's `tuneToBroadcastItem` (driven by the SSE schedule).
    // Calling playNext() while in broadcast mode is therefore either
    // a stale UI element (already removed in Pass 4) or an external
    // remote-control event (RNTP RemoteNext, also gated). Treat it as
    // a no-op so we cannot accidentally jump out of the channel feed.
    if (isBroadcastModeRef.current) return;

    const loop = loopRef.current;
    const shuffle = shuffleRef.current;

    if (loop === "one") {
      playerSeekRef.current?.(0);
      playerPlayRef.current?.();
      return;
    }

    setIsLive(false);
    setCurrentTime(0);
    setDuration(0);

    if (shuffle) {
      const sq = shuffledQueueRef.current;
      const nextPos = shufflePosRef.current + 1;
      if (nextPos >= sq.length) {
        if (loop === "none") {
          setIsPlaying(false);
          return;
        }
        const rebuiltQueue = buildShuffledQueue(queueRef.current);
        setShuffledQueue(rebuiltQueue);
        shuffledQueueRef.current = rebuiltQueue;
        setShufflePosition(0);
        const first = rebuiltQueue[0] ?? null;
        setCurrentSermon(first);
        if (first) {
          const qi = queueRef.current.findIndex((s) => s.id === first.id);
          if (qi >= 0) setCurrentIndex(qi);
        }
      } else {
        setShufflePosition(nextPos);
        const next = sq[nextPos] ?? null;
        setCurrentSermon(next);
        if (next) {
          const qi = queueRef.current.findIndex((s) => s.id === next.id);
          if (qi >= 0) setCurrentIndex(qi);
        }
      }
    } else {
      const q = queueRef.current;
      const nextIdx = currentIndexRef.current + 1;
      if (nextIdx >= q.length) {
        if (loop === "none") {
          setIsPlaying(false);
          return;
        }
        setCurrentIndex(0);
        setCurrentSermon(q[0] ?? null);
      } else {
        setCurrentIndex(nextIdx);
        setCurrentSermon(q[nextIdx] ?? null);
      }
    }

    setIsPlaying(true);
  }, []);

  const advanceToNext = useCallback(() => {
    playNext();
  }, [playNext]);

  const playPrevious = useCallback(() => {
    // Round 6 (Pass 4): same rationale as playNext — a TV channel has
    // no concept of "previous program", so this is a no-op in broadcast.
    if (isBroadcastModeRef.current) return;

    const loop = loopRef.current;
    const shuffle = shuffleRef.current;

    // When looping a single track, skip-back replays it from the start
    if (loop === "one") {
      playerSeekRef.current?.(0);
      playerPlayRef.current?.();
      return;
    }

    setIsLive(false);
    setCurrentTime(0);
    setDuration(0);

    if (shuffle) {
      const prevPos = Math.max(0, shufflePosRef.current - 1);
      setShufflePosition(prevPos);
      const prev = shuffledQueueRef.current[prevPos] ?? null;
      setCurrentSermon(prev);
      if (prev) {
        const qi = queueRef.current.findIndex((s) => s.id === prev.id);
        if (qi >= 0) setCurrentIndex(qi);
      }
    } else {
      const q = queueRef.current;
      const idx = currentIndexRef.current;
      const prevIdx = idx === 0 ? (loop === "none" ? 0 : q.length - 1) : idx - 1;
      setCurrentIndex(prevIdx);
      setCurrentSermon(q[prevIdx] ?? null);
    }

    setIsPlaying(true);
  }, []);

  const setQueue = useCallback((sermons: Sermon[]) => {
    setQueueState(sermons);
    if (shuffleRef.current) {
      const rebuilt = buildShuffledQueue(sermons, currentSermonRef.current?.youtubeId);
      setShuffledQueue(rebuilt);
      setShufflePosition(0);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    // Full teardown — opposite of pause. We:
    //   1) pause the underlying player engine (iframe / native player)
    //   2) clear the now-playing state so PersistentAudioPlayer unmounts
    //      its hidden iframe (no ghost audio, no DOM cost)
    //   3) reset the native TrackPlayer so the lock-screen / notification
    //      "Now Playing" tile disappears (otherwise it lingers on Android
    //      until the OS reclaims the foreground service)
    // This is what gets called when the user hits Stop, when the sleep
    // timer expires, when the browser tab closes, and on app teardown.
    try {
      playerPauseRef.current?.();
    } catch {}
    setIsPlaying(false);
    setCurrentSermon(null);
    setIsLive(false);
    // Round 6 (Pass 4): a full stop must also exit broadcast mode so
    // the next surface the user sees (Home, Radio, MiniPlayer) starts
    // from a clean slate. Without this, the MiniPlayer would still
    // think it was tuned to a channel even though playback has ended.
    setIsBroadcastMode(false);
    setCurrentTime(0);
    setDuration(0);
    if (Platform.OS !== "web") {
      stopTrackPlayer().catch(() => {});
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Mutual-exclusion registration — lets RadioStreamContext stop VOD via
  // audioController.requestVodStop() without creating a circular import.
  // ---------------------------------------------------------------------------
  const stopPlaybackRef = useRef(stopPlayback);
  stopPlaybackRef.current = stopPlayback;

  useEffect(() => {
    audioController.registerVodStop(() => stopPlaybackRef.current());
    // Registration intentionally persists for the app lifetime — no cleanup.
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") {
      // Web: 'pagehide' fires for both tab close and browser navigation
      // (and unlike 'beforeunload' it works with the back-forward cache
      // and on iOS Safari). 'visibilitychange→hidden' is a defensive
      // backstop for cases where pagehide is suppressed.
      const handleTeardown = () => {
        try {
          stopPlaybackRef.current();
        } catch {}
      };
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", handleTeardown);
        window.addEventListener("beforeunload", handleTeardown);
        return () => {
          window.removeEventListener("pagehide", handleTeardown);
          window.removeEventListener("beforeunload", handleTeardown);
        };
      }
      return;
    }

    // Native: AppState transitions to 'inactive' on swipe-up app-switcher
    // and 'background' when the app is sent to the background. We do NOT
    // stop playback on background (that would defeat the purpose of radio
    // mode). The native TrackPlayer's `appKilledPlaybackBehavior:
    // StopPlaybackAndRemoveNotification` already handles full app kill —
    // here we just guarantee the JS state is clean if the runtime
    // gets a chance to run cleanup.
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      // Reserved for future hooks (e.g. analytics on background).
      // Intentionally NOT calling stopPlayback on 'background' — the
      // whole point of radio is to keep playing in the background.
      void next;
    });
    return () => sub.remove();
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(100, v));
    setVolumeState(clamped);
    playerVolumeRef.current?.(clamped);
  }, []);

  const seekTo = useCallback((time: number) => {
    setCurrentTime(time);
    playerSeekRef.current?.(time);
  }, []);

  const updatePlayback = useCallback((time: number, dur: number) => {
    setCurrentTime(time);
    if (dur > 0) setDuration(dur);
  }, []);

  const value = useMemo(
    () => ({
      currentSermon,
      nextSermon,
      isPlaying,
      isRadioMode,
      isLive,
      isBroadcastMode,
      queue,
      currentIndex,
      dataSaver,
      shuffleMode,
      loopMode,
      volume,
      playSermon,
      playLive,
      togglePlay,
      toggleRadioMode,
      toggleDataSaver,
      toggleShuffle,
      cycleLoopMode,
      playNext,
      playPrevious,
      advanceToNext,
      setQueue,
      stopPlayback,
      setVolume,
      seekTo,
      updatePlayback,
      setIsBroadcastMode,
      playerPlayRef,
      playerPauseRef,
      playerSeekRef,
      playerVolumeRef,
    }),
    [
      currentSermon,
      nextSermon,
      isPlaying,
      isRadioMode,
      isLive,
      isBroadcastMode,
      queue,
      currentIndex,
      dataSaver,
      shuffleMode,
      loopMode,
      volume,
      playSermon,
      playLive,
      togglePlay,
      toggleRadioMode,
      toggleDataSaver,
      toggleShuffle,
      cycleLoopMode,
      playNext,
      playPrevious,
      advanceToNext,
      setQueue,
      stopPlayback,
      setVolume,
      seekTo,
      updatePlayback,
    ],
  );

  const progressValue = useMemo(() => ({ currentTime, duration }), [currentTime, duration]);

  return (
    <PlayerContext.Provider value={value}>
      <PlayerProgressContext.Provider value={progressValue}>
        {children}
      </PlayerProgressContext.Provider>
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
}

export function usePlayerProgress() {
  return useContext(PlayerProgressContext);
}
