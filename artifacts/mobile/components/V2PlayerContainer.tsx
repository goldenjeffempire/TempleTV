/**
 * V2PlayerContainer — Expo/React Native broadcast surface backed by
 * `@workspace/player-core`'s React Native bindings.
 *
 * Architecture:
 *   • Two `<Video>` (expo-av) buffers are mounted permanently. Neither ever
 *     unmounts; we only `bind`/`play`/`pause`/`unbind` via store updates.
 *   • Active buffer renders on top (zIndex 2, audible); inactive sits behind
 *     muted, ready for hand-off.
 *   • Real device events (`onLoad`, `onPlaybackStatusUpdate`, `onError`) are
 *     piped back into the FSM as `buffer-ready` / `buffer-ended` /
 *     `buffer-error` so the machine stays in sync with reality.
 *
 * Used by `app/player.tsx` for the live HLS path (v2 broadcast).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, StyleSheet, Text, View } from "react-native";
import { ResizeMode, Video, type AVPlaybackStatus } from "expo-av";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import type { MobileBufferState } from "@workspace/player-core/adapters/mobile";

// Audio session (playsInSilentModeIOS, staysActiveInBackground, DoNotMix
// interruption mode) is configured globally in app/_layout.tsx at app boot.
// Do NOT call Audio.setAudioModeAsync here — it is a global API and would
// override the app-wide policy on every player mount.

interface Props {
  baseUrl: string;
  channelId?: string;
  /** Called when the FSM enters FATAL — parent can route to a fallback UI. */
  onFatal?: () => void;
  /**
   * Force-mute audio regardless of adapter store. Use for thumbnail-style
   * previews (e.g. homepage hero) where audio would conflict with the rest
   * of the page.
   */
  muted?: boolean;
  /**
   * Suppress the large centered tuning/off-air overlay and reconnecting
   * banner so the surface can be used as a small inline preview without a
   * full-screen takeover. Tap-through is the parent's responsibility.
   */
  minimal?: boolean;
}

function sourceUrl(state: MobileBufferState, excludeYouTube: boolean): string | null {
  const item = state.item;
  if (!item) return null;
  if ("source" in item) {
    // Hero preview path (excludeYouTube=true) refuses to bind a YouTube
    // source — expo-av cannot play YouTube URLs anyway, and policy keeps
    // the homepage hero a "platform broadcast only" surface. The parent
    // can fall back to a thumbnail; full-screen player has its own
    // YouTube iframe path.
    if (excludeYouTube && item.source.kind === "youtube") return null;
    return item.source.url;
  }
  // V2Override is also kind-aware; same rule applies.
  if (excludeYouTube && item.kind === "youtube") return null;
  return item.url;
}

interface BufferProps {
  bufferId: "A" | "B";
  state: MobileBufferState;
  reportBufferEvent: ReturnType<typeof useV2BroadcastNative>["reportBufferEvent"];
  forceMuted?: boolean;
  excludeYouTube?: boolean;
}

const BroadcastBuffer = React.memo(function BroadcastBuffer({
  bufferId,
  state,
  reportBufferEvent,
  forceMuted = false,
  excludeYouTube = false,
}: BufferProps) {
  const ref = useRef<Video>(null);
  const url = sourceUrl(state, excludeYouTube);
  // Track the last bind revision that produced a buffer-ready report rather
  // than the URL string. URL-based dedup caused RECOVERING_PRIMARY to silently
  // swallow the onLoad event when the same URL was rebound after a failure,
  // leaving the FSM stuck in RECOVERING_PRIMARY until the watchdog fired.
  const lastReportedRevision = useRef<number>(-1);

  // Tracks the bindRevision for which onLoad has fired. This prevents
  // playFromPositionAsync being called before expo-av has finished loading
  // the new source — without this guard the FSM emits a `play` intent
  // (positionSecs ≥ 0) right after the `bind` intent, and the imperative
  // call on an unloaded <Video> rejects, firing a spurious buffer-error
  // that triggers an unnecessary RECOVERING_PRIMARY cycle.
  // Using React state (not a ref) so the play effect re-runs automatically
  // when onLoad fires and sets the loaded revision.
  const [loadedRevision, setLoadedRevision] = useState(-1);

  // Reset loaded state whenever a new source is bound.
  useEffect(() => {
    setLoadedRevision(-1);
  }, [state.bindRevision]);

  // Drive playback against the imperative expo-av API.
  // Guard: only call playFromPositionAsync once onLoad has confirmed the
  // source is ready for this bind revision.  Pause calls are safe at any
  // time so they don't need the same guard.
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    if (state.playing) {
      if (loadedRevision !== state.bindRevision) return; // not ready yet — wait for onLoad
      v.playFromPositionAsync(state.positionSecs * 1000).catch(() => {
        reportBufferEvent({ type: "buffer-error", bufferId, error: "play-failed" });
      });
    } else {
      v.pauseAsync().catch(() => {});
    }
  }, [state.playing, state.positionSecs, state.bindRevision, loadedRevision, url, bufferId, reportBufferEvent]);

  // Mute follows the adapter store (only the active buffer is audible),
  // unless `forceMuted` is set by the parent — used by the homepage hero
  // preview which must never play audio.
  const effectiveMuted = forceMuted || state.muted;
  useEffect(() => {
    ref.current?.setIsMutedAsync(effectiveMuted).catch(() => {});
  }, [effectiveMuted]);

  if (!url) {
    return <View style={[styles.video, { zIndex: state.active ? 2 : 1 }]} />;
  }

  return (
    <Video
      ref={ref}
      source={{ uri: url }}
      style={[styles.video, { zIndex: state.active ? 2 : 1 }]}
      resizeMode={ResizeMode.CONTAIN}
      shouldPlay={false}
      isMuted={effectiveMuted}
      onLoad={() => {
        // Mark this bind revision as loaded so the play useEffect can
        // proceed (it guards on loadedRevision === state.bindRevision).
        setLoadedRevision(state.bindRevision);
        if (lastReportedRevision.current !== state.bindRevision) {
          lastReportedRevision.current = state.bindRevision;
          reportBufferEvent({ type: "buffer-ready", bufferId });
        }
      }}
      onPlaybackStatusUpdate={(status: AVPlaybackStatus) => {
        if (!status.isLoaded) {
          if (status.error) {
            reportBufferEvent({ type: "buffer-error", bufferId, error: status.error });
          }
          return;
        }
        if (status.didJustFinish) {
          reportBufferEvent({ type: "buffer-ended", bufferId });
        }
      }}
      onError={(error) => {
        reportBufferEvent({
          type: "buffer-error",
          bufferId,
          error: typeof error === "string" ? error : "media-error",
        });
      }}
    />
  );
});

// ── Midnight Prayers channel switching ───────────────────────────────────────

interface MPScheduleConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

function isInMpWindow(cfg: MPScheduleConfig): boolean {
  if (!cfg.enabled) return false;
  const h = new Date().getHours();
  return cfg.endHour > cfg.startHour
    ? h >= cfg.startHour && h < cfg.endHour
    : h >= cfg.startHour || h < cfg.endHour;
}

function useMidnightPrayersSwitch(mainBaseUrl: string): string {
  const [cfg, setCfg] = useState<MPScheduleConfig | null>(null);
  const [inWindow, setInWindow] = useState(false);

  useEffect(() => {
    // Derive midnight-prayers config endpoint from the main baseUrl
    const apiOrigin = mainBaseUrl.replace(/\/api\/broadcast-v2.*/, "");
    fetch(`${apiOrigin}/api/midnight-prayers/config`)
      .then((r) => (r.ok ? (r.json() as Promise<MPScheduleConfig>) : null))
      .then((data) => { if (data) setCfg(data); })
      .catch(() => { /* stay on main channel */ });
  }, [mainBaseUrl]);

  useEffect(() => {
    if (!cfg) return;
    const check = () => setInWindow(isInMpWindow(cfg));
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [cfg]);

  if (!cfg || !inWindow) return mainBaseUrl;
  return mainBaseUrl.replace(/\/api\/broadcast-v2.*/, "/api/midnight-prayers");
}

// ── Component ─────────────────────────────────────────────────────────────────

export function V2PlayerContainer({
  baseUrl,
  channelId: _channelId = "main",
  onFatal,
  muted = false,
  minimal = false,
}: Props) {
  void _channelId;
  const effectiveBaseUrl = useMidnightPrayersSwitch(baseUrl);
  const { snapshot, connected, buffers, reportBufferEvent, forceReconnect, notifyOnline } =
    useV2BroadcastNative({ baseUrl: effectiveBaseUrl });

  const fatalFiredRef = useRef(false);
  useEffect(() => {
    if (snapshot.state === "FATAL" && !fatalFiredRef.current) {
      fatalFiredRef.current = true;
      onFatal?.();
    }
    if (snapshot.state !== "FATAL") fatalFiredRef.current = false;
  }, [snapshot.state, onFatal]);

  // RN AppState bridge: when the app returns to foreground, force a fresh
  // WS handshake. iOS/Android suspend the JS runtime when backgrounded,
  // and the OS may drop the underlying socket silently — the JS-side
  // WebSocket object can stay in OPEN state for minutes after wake, never
  // emitting `onclose`. Without this nudge, the player would sit on a dead
  // socket and the queue/now-playing would freeze until the user does
  // something that triggers a network round-trip.
  useEffect(() => {
    let last = AppState.currentState;
    let mounted = true;
    const sub = AppState.addEventListener("change", (next) => {
      // Belt-and-braces guard: although sub.remove() in the cleanup below
      // unregisters this handler synchronously on unmount, some RN versions
      // can still flush a queued AppState change event after removal. The
      // mounted flag ensures we never poke transport methods on an already
      // torn-down hook, eliminating "setState on unmounted component" noise
      // and the associated WS keep-alive leak.
      if (!mounted) return;
      if (last !== "active" && next === "active") {
        notifyOnline();
        forceReconnect();
      }
      last = next;
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [forceReconnect, notifyOnline]);

  const server = snapshot.lastServerSnapshot;
  const overlay = useMemo(() => {
    if (snapshot.state === "OFFLINE_HOLD") return "Reconnecting…";
    if (snapshot.state === "FATAL") return "We encountered a playback issue — please try again in a moment.";
    if (server?.failover.active) return server.failover.reason ?? "On standby";
    // BOOTSTRAP/SYNCING MUST resolve before off-air so the cold-load
    // flash (snapshot has arrived but FSM hasn't bound a buffer yet)
    // shows "Tuning in…" instead of a misleading off-air state.
    if (snapshot.state === "BOOTSTRAP") return "Tuning in…";
    if (snapshot.state === "SYNCING") {
      if (server && !server.current && !server.override) return "Temple TV is currently off-air — we'll be back shortly.";
      return "Tuning in…";
    }
    // Buffer loading: a new item has been bound to the active buffer but
    // `buffer-ready` hasn't fired yet. Keep the "Tuning in…" overlay visible
    // so the user sees activity during initial load — not a silent black box.
    if (snapshot.state === "PREPARING_ACTIVE") return "Tuning in…";
    // Active playback states — content is bound and playing; suppress any
    // overlay so a transient server-snapshot gap between queue items never
    // produces a misleading overlay flash over a playing video.
    if (
      snapshot.state === "PLAYING" ||
      snapshot.state === "HANDOFF" ||
      snapshot.state === "PREPARING_NEXT"
    ) return null;
    // Recovery states are transient buffer errors, not a true off-air event.
    if (
      snapshot.state === "RECOVERING_PRIMARY" ||
      snapshot.state === "RECOVERING_FAILOVER" ||
      snapshot.state === "SKIP_PENDING"
    ) return "Tuning in…";
    // All remaining states: genuinely off air only when server has no content.
    if (server && !server.current && !server.override) return "Temple TV is currently off-air — we'll be back shortly.";
    return null;
  }, [snapshot.state, server]);

  // Poster: show the upcoming/current sermon thumbnail behind the buffers
  // while the player is still tuning in, off-air, reconnecting, or in any
  // other non-PLAYING state. Without this the user sees a black box for
  // 1–3 seconds on cold open or after every reconnect — a TV-grade
  // experience needs *something* on screen at all times. We prefer the
  // current item's thumb (what they're about to watch) and fall back to
  // `next` so the surface is never bare when the queue is between items.
  const posterUrl = useMemo(() => {
    const t = server?.current?.thumbnailUrl ?? server?.next?.thumbnailUrl ?? null;
    return t && t.length > 0 ? t : null;
  }, [server]);
  const showPoster = !!overlay && !!posterUrl;

  return (
    <View style={styles.root}>
      {/* ── Cinematic ambient background ────────────────────────────────────
          Always-visible blurred version of the current item's thumbnail fills
          letterbox/pillarbox areas (produced by ResizeMode.CONTAIN) with a
          soft ambient glow instead of harsh black bars. Matches what Netflix
          and Apple TV+ do: content is never cropped but empty space is never
          empty either. blurRadius=25 is hardware-accelerated on iOS/Android.  */}
      {posterUrl && !minimal && (
        <Image
          source={{ uri: posterUrl }}
          style={styles.ambient}
          blurRadius={25}
          accessible={false}
        />
      )}

      {/* Sharp poster — shown only in overlay states (tuning/off-air/reconnecting) */}
      {showPoster && !minimal && (
        <Image
          source={{ uri: posterUrl! }}
          style={styles.poster}
          resizeMode="contain"
          accessible={false}
        />
      )}

      <BroadcastBuffer
        bufferId="A"
        state={buffers.A}
        reportBufferEvent={reportBufferEvent}
        forceMuted={muted}
        excludeYouTube={minimal}
      />
      <BroadcastBuffer
        bufferId="B"
        state={buffers.B}
        reportBufferEvent={reportBufferEvent}
        forceMuted={muted}
        excludeYouTube={minimal}
      />

      {!connected && !minimal && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Reconnecting to broadcast…</Text>
        </View>
      )}

      {overlay && !minimal && (
        <View style={styles.overlay}>
          {/* Show spinner only during transient states (tuning/reconnecting),
              not for definitive states like Off air or Broadcast unavailable
              where a spinner would imply something is loading when it isn't. */}
          {overlay !== "Temple TV is currently off-air — we'll be back shortly." && overlay !== "We encountered a playback issue — please try again in a moment." && (
            <ActivityIndicator color="#fff" size="large" style={{ marginBottom: 12 }} />
          )}
          <Text style={styles.overlayText}>{overlay}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  video: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  ambient: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    zIndex: 0,
    opacity: 0.35,
    resizeMode: "cover",
  },
  poster: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    zIndex: 5,
  },
  banner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(217, 119, 6, 0.92)",
    paddingVertical: 6,
    zIndex: 30,
  },
  bannerText: {
    color: "#000",
    textAlign: "center",
    fontWeight: "600",
    fontSize: 13,
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 20,
  },
  overlayText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
});
