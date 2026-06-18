/**
 * RadioStreamContext — centralized live radio stream engine.
 *
 * Architecture:
 *   • Admin configures a stream URL (HLS .m3u8 or direct MP3/AAC) via the
 *     Admin → Radio page. It is stored in app_config and served at GET /api/radio.
 *   • ALL clients connect to the SAME stream URL — because it is a live feed
 *     (no seeking) everyone who is connected hears exactly the same audio at
 *     the same time, just like a radio station.
 *   • On native (iOS/Android): expo-av Audio.Sound handles HLS + direct streams
 *     via the platform's native media engine (AVPlayer on iOS, ExoPlayer on
 *     Android). Both support background playback when the audio session is
 *     configured for it (done in app/_layout.tsx's setupAudioSession).
 *   • On web: a hidden HTML <audio> element plays the stream. HLS is natively
 *     supported by Safari; Chrome/Firefox receive direct MP3/AAC streams.
 *
 * Radio Mode lifecycle:
 *   toggleRadio() ON  → stop any VOD (mutual exclusion) → fetch config →
 *                       create audio object → start playing
 *   toggleRadio() OFF → pause + unload audio → release all resources immediately
 *   stopRadio()       → same as OFF (callable externally, e.g. from PlayerContext)
 *   App unmount       → same as OFF (teardown in cleanup effect)
 *
 * Reconnection:
 *   On any playback error or stall, an exponential-backoff retry is scheduled
 *   by bumping `reconnectKey` state which re-triggers the playback effect.
 *   Sequence: 2 s → 4 s → 8 s → 16 s → 30 s (capped, resets on success).
 *
 * Stall watchdog (native):
 *   A 30-second interval watches whether expo-av is reporting isPlaying=true
 *   but the stream heartbeat (last "playing" status timestamp) has not updated.
 *   If it stalls silently without firing an error, a reconnect is forced.
 *
 * AppState recovery:
 *   When the app returns to the foreground and radio is ON, we verify the
 *   audio object is still actively playing. If it has died silently (network
 *   dropped while backgrounded) we bump reconnectKey to trigger a fresh cycle.
 *
 * Mutual exclusion:
 *   When radio turns ON, audioController.requestVodStop() stops any sermon
 *   playing in PlayerContext. When a sermon starts in PlayerContext it calls
 *   audioController.requestRadioStop() → our stopRadio() callback is invoked.
 *
 * State persistence:
 *   `isRadioOn` is persisted to AsyncStorage so the mode survives background /
 *   foreground cycles and in-app navigation. It is NOT restored on cold start —
 *   audio must be explicitly re-enabled by the user each session (requirement).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBase } from "@/lib/apiBase";
import * as audioController from "@/services/audioController";

// ── Config ────────────────────────────────────────────────────────────────────
const RADIO_MODE_KEY = "@TempleTV/liveRadioOn";
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
/** Seconds without a "playing" heartbeat before we force a reconnect. */
const STALL_THRESHOLD_MS = 30_000;
/** How often we check for a stall (native only). */
const STALL_CHECK_INTERVAL_MS = 10_000;

interface RadioConfig {
  streamUrl:   string | null;
  title:       string;
  description: string;
  isActive:    boolean;
}

// ── Context shape ─────────────────────────────────────────────────────────────
export interface RadioStreamContextType {
  streamUrl:          string | null;
  stationTitle:       string;
  stationDescription: string;
  /** True when admin has configured a URL AND set isActive = true */
  isStreamConfigured: boolean;
  configLoading:      boolean;

  /** User's Radio Mode toggle — persisted across navigation */
  isRadioOn:    boolean;
  /** Actively buffering / connecting */
  isConnecting: boolean;
  /** Playback error state */
  isError:   boolean;
  errorMsg:  string | null;

  toggleRadio:  () => void;
  retryConnect: () => void;
  /**
   * Imperatively stop radio (does NOT toggle — always stops).
   * Called by audioController when VOD starts in PlayerContext.
   */
  stopRadio: () => void;
}

const RadioStreamContext = createContext<RadioStreamContextType | null>(null);

export function useRadioStream(): RadioStreamContextType {
  const ctx = useContext(RadioStreamContext);
  if (!ctx) throw new Error("useRadioStream must be used inside <RadioStreamProvider>");
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function RadioStreamProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<RadioConfig>({
    streamUrl:   null,
    title:       "Temple TV Radio",
    description: "Live 24/7 Christian broadcast",
    isActive:    false,
  });
  const [configLoading, setConfigLoading] = useState(true);

  // isRadioOn intentionally starts as false every session — user must
  // explicitly tap the toggle each time (per spec: "no auto-restart").
  const [isRadioOn,    setIsRadioOn]    = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isError,      setIsError]      = useState(false);
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null);

  // Bumped to force a reconnect attempt (triggers the playback effect).
  const [reconnectKey, setReconnectKey] = useState(0);

  const mountedRef        = useRef(true);
  const retryCount        = useRef(0);
  const retryTimer        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimer        = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPlayingAt     = useRef<number>(0);    // epoch ms of last "isPlaying=true" status
  const isConnectingRef   = useRef(false);
  isConnectingRef.current = isConnecting;

  // Mirror of isRadioOn as a ref so AppState/stall callbacks always read
  // the current value without stale closure issues.
  const isRadioOnRef    = useRef(false);
  isRadioOnRef.current  = isRadioOn;

  // ── Fetch stream config from API (with 3-attempt retry) ──────────────────
  useEffect(() => {
    const base = getApiBase();
    if (!base) { setConfigLoading(false); return; }

    let cancelled = false;

    async function fetchWithRetry(attemptsLeft: number, delayMs: number): Promise<void> {
      try {
        const r = await fetch(`${base}/api/radio`, { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json() as RadioConfig;
        if (!cancelled && mountedRef.current) setConfig(data);
      } catch (err) {
        if (cancelled) return;
        if (attemptsLeft > 1) {
          await new Promise<void>((res) => setTimeout(res, delayMs));
          if (!cancelled) return fetchWithRetry(attemptsLeft - 1, delayMs * 2);
        }
        // All retries exhausted — leave defaults in place; app remains usable
        if (process.env.NODE_ENV !== "production") {
          if (__DEV__) console.warn("[RadioStreamContext] Failed to fetch radio config:", err);
        }
      } finally {
        if (!cancelled && mountedRef.current) setConfigLoading(false);
      }
    }

    fetchWithRetry(3, 2_000).catch(() => {
      if (!cancelled && mountedRef.current) setConfigLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  // ── Schedule a reconnect attempt ──────────────────────────────────────────
  const scheduleRetry = useCallback(() => {
    if (retryTimer.current) return; // already pending
    const delay = RETRY_DELAYS_MS[Math.min(retryCount.current, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    retryCount.current++;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      if (mountedRef.current) {
        setReconnectKey((k) => k + 1);
      }
    }, delay);
  }, []);

  // ── Stall watchdog helpers ────────────────────────────────────────────────
  const startStallWatchdog = useCallback(() => {
    if (stallTimer.current || Platform.OS === "web") return;
    lastPlayingAt.current = Date.now(); // start fresh
    stallTimer.current = setInterval(() => {
      if (!mountedRef.current || !isRadioOnRef.current) return;
      const msSinceLastPlay = Date.now() - lastPlayingAt.current;
      // Only trigger if we expect to be playing (not during connecting or error)
      if (!isConnectingRef.current && msSinceLastPlay > STALL_THRESHOLD_MS) {
        lastPlayingAt.current = Date.now(); // reset before reconnect to avoid rapid-fire
        setReconnectKey((k) => k + 1);
      }
    }, STALL_CHECK_INTERVAL_MS);
  }, []);

  const stopStallWatchdog = useCallback(() => {
    if (stallTimer.current) {
      clearInterval(stallTimer.current);
      stallTimer.current = null;
    }
  }, []);

  // ── Core playback effect ──────────────────────────────────────────────────
  // Runs whenever the user toggles radio ON/OFF, config changes, or a
  // reconnect is triggered. The cleanup function is the single source of
  // truth for stopping audio — it always runs before the next execution.
  useEffect(() => {
    if (!isRadioOn || !config.streamUrl || !config.isActive) {
      // Nothing to play — reset UI state and bail
      setIsConnecting(false);
      setIsError(false);
      setErrorMsg(null);
      stopStallWatchdog();
      return;
    }

    const url = config.streamUrl;
    let cancelled = false;

    setIsConnecting(true);
    setIsError(false);
    setErrorMsg(null);

    if (Platform.OS === "web") {
      // ── Web: HTML <audio> ─────────────────────────────────────────────────
      const audio = new window.Audio();
      (audio as any).crossOrigin = "anonymous";
      audio.preload = "none";
      audio.src = url;

      audio.addEventListener("playing", () => {
        if (cancelled || !mountedRef.current) return;
        setIsConnecting(false);
        setIsError(false);
        retryCount.current = 0;
      });

      audio.addEventListener("error", () => {
        if (cancelled || !mountedRef.current) return;
        setIsError(true);
        setIsConnecting(false);
        setErrorMsg("Stream connection failed. Retrying…");
        scheduleRetry();
      });

      audio.addEventListener("stalled", () => {
        if (cancelled || !mountedRef.current) return;
        scheduleRetry();
      });

      audio.addEventListener("waiting", () => {
        if (cancelled || !mountedRef.current) return;
        setIsConnecting(true);
      });

      audio.play().catch(() => {
        if (cancelled || !mountedRef.current) return;
        setIsConnecting(false);
        setIsError(true);
        setErrorMsg("Tap Retry to start the stream.");
      });

      return () => {
        cancelled = true;
        audio.pause();
        audio.src = "";
        audio.load(); // fully releases the media resource
      };
    }

    // ── Native: expo-av Audio.Sound ───────────────────────────────────────
    let soundObj: import("expo-av").Audio.Sound | null = null;

    // Start the stall watchdog before the async load so we catch hangs
    startStallWatchdog();

    (async () => {
      try {
        const { Audio } = await import("expo-av");
        const { sound } = await Audio.Sound.createAsync(
          { uri: url },
          {
            shouldPlay:  true,
            isLooping:   false,
            volume:      1.0,
            // Frequent status updates drive the stall watchdog
            progressUpdateIntervalMillis: 250,
          },
          (status) => {
            if (cancelled || !mountedRef.current) return;
            if (!status.isLoaded) {
              if (status.error) {
                stopStallWatchdog();
                setIsError(true);
                setIsConnecting(false);
                setErrorMsg("Stream error. Retrying…");
                scheduleRetry();
              }
            } else if (status.isPlaying) {
              // Heartbeat — stall watchdog uses this timestamp
              lastPlayingAt.current = Date.now();
              setIsConnecting(false);
              setIsError(false);
              retryCount.current = 0;
            } else if (status.isBuffering) {
              setIsConnecting(true);
            }
          },
        );

        if (cancelled) {
          await sound.unloadAsync();
          return;
        }
        soundObj = sound;
      } catch {
        if (cancelled || !mountedRef.current) return;
        stopStallWatchdog();
        setIsError(true);
        setIsConnecting(false);
        setErrorMsg("Could not load stream. Retrying…");
        scheduleRetry();
      }
    })();

    return () => {
      cancelled = true;
      stopStallWatchdog();
      if (soundObj) {
        soundObj.unloadAsync().catch(() => {});
        soundObj = null;
      }
    };
    // reconnectKey intentionally included — bumping it forces a full
    // teardown + re-create cycle which is the reconnect mechanism.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRadioOn, config.streamUrl, config.isActive, reconnectKey, scheduleRetry, startStallWatchdog, stopStallWatchdog]);

  // ── AppState recovery (native only) ──────────────────────────────────────
  // When the app returns to the foreground and radio is ON, verify the
  // audio is still active. A network drop while backgrounded can silently
  // kill the stream without expo-av firing an error event.
  useEffect(() => {
    if (Platform.OS === "web") return;

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState !== "active") return;
      if (!isRadioOnRef.current || !mountedRef.current) return;
      // Give the OS 1.5s to re-establish the audio session after foregrounding
      // before we decide the stream is dead and trigger a reconnect.
      setTimeout(() => {
        if (!mountedRef.current || !isRadioOnRef.current) return;
        // If the stall watchdog shows the stream has been silent since before
        // we backgrounded (lastPlayingAt was set then), treat it as a dead stream.
        const msSilent = Date.now() - lastPlayingAt.current;
        if (msSilent > STALL_THRESHOLD_MS) {
          lastPlayingAt.current = Date.now(); // reset to avoid immediate re-fire
          setReconnectKey((k) => k + 1);
        }
      }, 1_500);
    };

    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      stopStallWatchdog();
    };
  }, [stopStallWatchdog]);

  // ── Public actions ────────────────────────────────────────────────────────

  /**
   * Imperatively stop radio without toggling. Used by audioController
   * when PlayerContext starts VOD playback so radio silently yields.
   */
  const stopRadio = useCallback(() => {
    if (!isRadioOnRef.current) return;
    setIsRadioOn(false);
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    retryCount.current = 0;
    setIsError(false);
    setErrorMsg(null);
    setIsConnecting(false);
    AsyncStorage.setItem(RADIO_MODE_KEY, "false").catch((e) => {
      if (process.env.NODE_ENV !== "production") {
        if (__DEV__) console.error("[RadioStreamContext] Failed to persist radio stop:", e);
      }
    });
  }, []);

  // Register our stop fn with the mutual-exclusion controller so
  // PlayerContext can call it when a sermon starts.
  useEffect(() => {
    audioController.registerRadioStop(stopRadio);
    // No cleanup — the registration should persist for the app lifetime.
  }, [stopRadio]);

  const toggleRadio = useCallback(() => {
    const next = !isRadioOn;
    setIsRadioOn(next);
    // Clear any pending retry when user explicitly toggles
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    if (next) {
      // Radio turning ON → stop any playing sermon first
      audioController.requestVodStop();
    } else {
      retryCount.current = 0;
      setIsError(false);
      setErrorMsg(null);
      setIsConnecting(false);
    }
    // Persist toggle state (for within-session navigation — not cold start)
    AsyncStorage.setItem(RADIO_MODE_KEY, String(next)).catch((e) => {
      if (process.env.NODE_ENV !== "production") {
        if (__DEV__) console.error("[RadioStreamContext] Failed to persist radio toggle:", e);
      }
    });
  }, [isRadioOn]);

  const retryConnect = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    retryCount.current = 0;
    setIsError(false);
    setErrorMsg(null);
    lastPlayingAt.current = Date.now(); // reset stall watchdog clock
    setReconnectKey((k) => k + 1);
  }, []);

  return (
    <RadioStreamContext.Provider
      value={{
        streamUrl:          config.streamUrl,
        stationTitle:       config.title,
        stationDescription: config.description,
        isStreamConfigured: !!config.streamUrl && config.isActive,
        configLoading,
        isRadioOn,
        isConnecting,
        isError,
        errorMsg,
        toggleRadio,
        retryConnect,
        stopRadio,
      }}
    >
      {children}
    </RadioStreamContext.Provider>
  );
}
