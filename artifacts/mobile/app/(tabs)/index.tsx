import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { LinearGradient } from "expo-linear-gradient";

import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { LiveBadge } from "@/components/LiveBadge";
import { SermonCard } from "@/components/SermonCard";
import { SectionHeader } from "@/components/SectionHeader";
import { SkeletonVerticalCard, SkeletonHorizontalCard, SkeletonLiveBanner } from "@/components/SkeletonCard";
import { NetworkBanner } from "@/components/NetworkBanner";
import { LiveNotificationBanner } from "@/components/LiveNotificationBanner";
import { usePlayer } from "@/context/PlayerContext";
import { checkLiveStatus, type LiveCheckResult } from "@/services/youtube";
import { sendLiveServiceNotification } from "@/services/notifications";
import { useWatchProgress } from "@/hooks/useWatchProgress";
import { checkBroadcastCurrent, subscribeBroadcastEvents, type BroadcastCurrentResult } from "@/services/broadcast";
import { reportLiveFailure, useLiveFailureFor, useLiveFallbackJustTriggered } from "@/services/liveFailureSignal";
import { useLiveCountdown } from "@/services/liveCountdown";
import {
  BROADCAST_TITLE,
  BROADCAST_LIVE_BANNER_TITLE,
  BROADCAST_PREACHER,
} from "@/lib/broadcastIdentity";
import { navigateToSermon, navigateToPlayer as gatedNavigateToPlayer } from "@/utils/navigation";
import { usePageSeo } from "@/hooks/usePageSeo";
import type { Sermon } from "@/types";

let HeroVideoComponent: any = null;
let HeroResizeMode: any = null;
try {
  const av = require("expo-av");
  HeroVideoComponent = av.Video;
  HeroResizeMode = av.ResizeMode;
} catch {}

// Round 8: removed the cinematic-hero "Up Next: <title>" chip. Per the
// broadcast-clean directive, the viewer sees no queue metadata, video
// titles, or upcoming-content previews on the broadcast surface — the
// hero behaves like a real TV channel where program identity is conveyed
// only by the live video itself, not by a textual "what's next" hint.
// Round 6 had already removed the per-second progress bar for the same
// reason. The component is intentionally not replaced — the underlying
// `nextItem` data continues to flow into the player for inactive-slot
// preload, it just isn't surfaced to the viewer.

export default function WatchScreen() {
  usePageSeo({
    title: "Temple TV — Live Worship, Sermons & 24/7 Broadcasting",
    description:
      "Join Jesus Christ Temple Ministry live. Stream worship services, sermons, and 24/7 Christian broadcasting on web, mobile, and Smart TV.",
    path: "/",
  });

  const c = useColors();
  const insets = useSafeAreaInsets();
  const { currentSermon, isLive: playerIsLive, playSermon, playLive, setQueue } = usePlayer();
  const { sermons, loading, refresh, isFromRss, error: feedError } = useYouTubeChannel();
  const { getProgress } = useWatchProgress();
  const { isOnline } = useNetworkStatus();
  const fadeAnim = useRef(new Animated.Value(Platform.OS === "web" ? 1 : 0)).current;
  const [liveStatus, setLiveStatus] = useState<LiveCheckResult>({ isLive: false, videoId: null, title: null });
  const [checkingLive, setCheckingLive] = useState(true);
  const [showLiveBanner, setShowLiveBanner] = useState(false);
  const [liveBannerDismissed, setLiveBannerDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [broadcastCurrent, setBroadcastCurrent] = useState<BroadcastCurrentResult | null>(null);
  const [heroVideoFailed, setHeroVideoFailed] = useState(false);
  const heroVideoRef = useRef<any>(null);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: Platform.OS !== "web" }).start();

    let lastSeenVideoId: string | null = null;

    const doLiveCheck = async (useCached = false) => {
      try {
        const [status, broadcastRes] = await Promise.all([
          checkLiveStatus(useCached),
          checkBroadcastCurrent(),
        ]);
        // An admin "Activate live stream" override (set in Live Control on
        // the admin dashboard) is the platform's authoritative live signal —
        // it must win over the YouTube channel auto-scrape so every surface
        // (this hero, the Live Now strip, the player) flips together to
        // whatever URL the admin pasted. Mirror the override videoId/title
        // back into liveStatus when present.
        const overrideVideoId = broadcastRes?.liveOverride?.youtubeVideoId ?? null;
        const overrideTitle = broadcastRes?.liveOverride?.title ?? null;
        const merged: LiveCheckResult = overrideVideoId
          ? {
              isLive: true,
              videoId: overrideVideoId,
              title: overrideTitle ?? status.title ?? null,
            }
          : status;
        setLiveStatus(merged);
        setBroadcastCurrent(broadcastRes);
        setCheckingLive(false);
        if (merged.isLive) {
          if (!liveBannerDismissed) setShowLiveBanner(true);
          if (merged.videoId !== lastSeenVideoId) {
            lastSeenVideoId = merged.videoId;
            sendLiveServiceNotification(merged.title ?? "Temple TV JCTM is LIVE!");
          }
          if (!autoStartedRef.current && !currentSermon && !playerIsLive) {
            autoStartedRef.current = true;
            playLive();
          }
        } else {
          setShowLiveBanner(false);
        }
      } catch {
        setCheckingLive(false);
      }
    };

    doLiveCheck(false);
    const interval = setInterval(() => doLiveCheck(true), 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Web browsers block unsolicited autoplay (and audio especially) — the
    // user must tap a play control. Auto-starting playback on the web is
    // bad UX and would silently fail anyway. Native (TV-like) clients keep
    // the cinematic auto-start.
    if (Platform.OS === "web") return;
    if (autoStartedRef.current || loading || sermons.length === 0) return;
    if (currentSermon || playerIsLive) { autoStartedRef.current = true; return; }
    autoStartedRef.current = true;
    const first = sermons[0];
    if (first) {
      setQueue(sermons);
      playSermon(first, sermons);
    }
  }, [loading, sermons]);

  useEffect(() => {
    // When a broadcast/current payload arrives via SSE, fold any active
    // admin override directly into `liveStatus` so handleLivePress, the
    // live banner, and the hero iframe all switch the moment the admin
    // pastes a new URL into Live Control — no waiting on the 60s YouTube
    // channel scrape, no divergence between this hero and the player.
    const applyOverrideFromBroadcast = (current: BroadcastCurrentResult | null | undefined) => {
      const overrideVideoId = current?.liveOverride?.youtubeVideoId ?? null;
      const overrideTitle = current?.liveOverride?.title ?? null;
      if (overrideVideoId) {
        setLiveStatus((prev) => {
          if (
            prev.isLive &&
            prev.videoId === overrideVideoId &&
            (prev.title ?? null) === (overrideTitle ?? prev.title ?? null)
          ) {
            return prev;
          }
          return {
            isLive: true,
            videoId: overrideVideoId,
            title: overrideTitle ?? prev.title ?? null,
          };
        });
        if (!liveBannerDismissed) setShowLiveBanner(true);
      }
      // When the override is cleared (override-expired), we deliberately
      // do NOT flip liveStatus.isLive=false here — the YouTube channel
      // scrape (yt-status SSE / 60s poll) is the authority for organic
      // live state, and prematurely hiding the live UI would cause a
      // flicker if the channel is still live independently.
    };

    const refreshBroadcast = async (payload?: any) => {
      if (payload?.current) {
        setBroadcastCurrent(payload.current);
        applyOverrideFromBroadcast(payload.current);
        return;
      }
      const latest = await checkBroadcastCurrent().catch(() => null);
      if (latest) {
        setBroadcastCurrent(latest);
        applyOverrideFromBroadcast(latest);
      }
    };

    const subscription = subscribeBroadcastEvents({
      "broadcast-current-updated": refreshBroadcast,
      "broadcast-queue-updated": () => refreshBroadcast(),
      "broadcast-schedule-updated": () => refreshBroadcast(),
      "broadcast-control-updated": () => refreshBroadcast(),
      "override-expired": () => refreshBroadcast(),
      status: (payload) => {
        if (payload) {
          // Admin override videoId (if any) wins over the channel scrape's
          // ytVideoId — same priority rule as the player and the TV.
          const overrideVideoId = payload.liveOverride?.youtubeVideoId ?? null;
          setLiveStatus({
            isLive: !!payload.isLive || !!overrideVideoId,
            videoId: overrideVideoId ?? payload.ytVideoId ?? null,
            title: payload.liveOverride?.title ?? payload.ytTitle ?? null,
          });
          setShowLiveBanner((!!payload.isLive || !!overrideVideoId) && !liveBannerDismissed);
        }
        refreshBroadcast();
      },
      "yt-status": (payload) => {
        if (payload) {
          // Don't clobber an active admin override with a stale channel
          // scrape result — the override is the source of truth until
          // override-expired fires.
          setLiveStatus((prev) => {
            const hasActiveOverride =
              prev.isLive && prev.videoId && prev.videoId !== payload.videoId;
            if (hasActiveOverride) {
              // Refetch to confirm the override is still active before
              // letting the channel scrape take over.
              checkBroadcastCurrent()
                .then((latest) => {
                  if (latest?.liveOverride?.youtubeVideoId) return;
                  setLiveStatus({
                    isLive: !!payload.isLive,
                    videoId: payload.videoId ?? null,
                    title: payload.title ?? null,
                  });
                })
                .catch(() => {});
              return prev;
            }
            return {
              isLive: !!payload.isLive,
              videoId: payload.videoId ?? null,
              title: payload.title ?? null,
            };
          });
        }
      },
    });

    return () => subscription?.close();
  }, [liveBannerDismissed]);

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isTabletLayout = windowWidth >= 768;
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const topPad = insets.top + webTopPad;
  // Cinematic hero occupies 62% of viewport on mobile, 52% on tablet.
  // On web, add the fixed nav-bar height so the hero starts below it.
  const heroHeight = Math.round(
    windowHeight * (isTabletLayout ? 0.52 : 0.62) + (Platform.OS === "web" ? webTopPad : 0),
  );

  const navigateToPlayer = useCallback((params: Record<string, string>) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    gatedNavigateToPlayer(params);
  }, []);

  const handleSermonPress = useCallback((sermon: Sermon) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const prog = getProgress(sermon.id);
    navigateToSermon(
      sermon,
      prog ? { startPositionMs: String(Math.floor(prog.position * 1000)) } : {},
    );
  }, [getProgress]);

  const handleLivePress = useCallback(() => {
    // Round 9c: pass the channel identity rather than `liveStatus.title`.
    // The player chrome already overrides this in broadcast/live mode,
    // but passing the generic value at the route level means even any
    // pre-render glance / accessibility readout / share-sheet capture
    // never sees the per-program title leak.
    navigateToPlayer({
      live: "true",
      title: BROADCAST_TITLE,
      preacher: BROADCAST_PREACHER,
      ...(liveStatus.videoId ? { videoId: liveStatus.videoId } : {}),
    });
  }, [navigateToPlayer, liveStatus]);

  const handleBroadcastPress = useCallback(() => {
    const currentBroadcast = broadcastCurrent;

    checkBroadcastCurrent()
      .then((latest) => { if (latest) setBroadcastCurrent(latest); })
      .catch(() => {});

    if (currentBroadcast?.activeSchedule?.contentType === "live") {
      handleLivePress();
      return;
    }
    const item = currentBroadcast?.item;
    if (!item) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const elapsed = currentBroadcast?.serverTimeMs
      ? Math.max(0, Math.round((Date.now() - currentBroadcast.serverTimeMs) / 1000))
      : 0;
    const startMs = String(((currentBroadcast?.positionSecs ?? 0) + elapsed) * 1000);

    if (item.videoSource === "local" && item.localVideoUrl) {
      router.push({
        pathname: "/player",
        params: {
          broadcastMode: "true",
          localVideoUrl: item.localVideoUrl,
          hlsMasterUrl: (item as any).hlsMasterUrl ?? undefined,
          title: item.title,
          thumbnail: item.thumbnailUrl,
          startPositionMs: startMs,
        },
      });
    } else {
      router.push({
        pathname: "/player",
        params: {
          broadcastMode: "true",
          videoId: item.youtubeId,
          title: item.title,
          thumbnail: item.thumbnailUrl,
          startPositionMs: startMs,
        },
      });
    }
  }, [broadcastCurrent, handleLivePress]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      refresh(),
      checkLiveStatus().then((status) => {
        setLiveStatus(status);
        if (status.isLive && !liveBannerDismissed) setShowLiveBanner(true);
      }),
      checkBroadcastCurrent().then((bc) => setBroadcastCurrent(bc)),
    ]);
    setRefreshing(false);
  };

  const broadcastItem = broadcastCurrent?.item ?? null;
  // Subscribe to the live-failure signal so when the YouTube live iframe
  // (here in the hero, OR over in the full-screen player) reports a failure,
  // this surface treats the platform as not-live for ~60 s. That trips
  // `showBroadcast` below, so the hero / Live Now strip render the broadcast
  // queue instead of staring at a broken embed. Auto-recovers when the
  // cool-down expires or when the active live videoId changes (admin pasted
  // a new URL).
  const liveYoutubeFailed = useLiveFailureFor(liveStatus.videoId);
  const effectiveLiveActive = liveStatus.isLive && !liveYoutubeFailed;
  // One-shot banner: flashes for ~5 s when the live YouTube embed for this
  // device just dropped, so viewers understand why the cinematic preview
  // suddenly switched to the broadcast queue.
  const showLiveFallbackBanner = useLiveFallbackJustTriggered(liveStatus.videoId);
  const showScheduledLive = !effectiveLiveActive && broadcastCurrent?.activeSchedule?.contentType === "live";
  // Real-time, server-time-aligned countdown to the scheduled start.
  // Returns null when out of window (>24h, in the past, missing data) so
  // the badge below quietly hides itself when there's nothing to show.
  const liveCountdown = useLiveCountdown(
    showScheduledLive ? broadcastCurrent?.activeSchedule?.startTime ?? null : null,
    broadcastCurrent?.serverTimeMs ?? null,
  );
  const showBroadcast = !effectiveLiveActive && (broadcastItem !== null || showScheduledLive);

  // Compute the join offset ONCE per broadcast item so re-renders from drift
  // updates don't re-seek the hero video on every tick. The drift-correction
  // effect below handles ongoing sync via setPositionAsync().
  const heroInitialPositionMillis = useMemo(() => {
    if (!broadcastCurrent?.item) return 0;
    const drift = broadcastCurrent.serverTimeMs
      ? (Date.now() - broadcastCurrent.serverTimeMs) / 1000
      : 0;
    const targetSecs = (broadcastCurrent.positionSecs ?? 0) + drift;
    const dur = broadcastCurrent.item.durationSecs ?? 0;
    const clamped = dur > 0
      ? Math.max(0, Math.min(targetSecs, dur - 0.5))
      : Math.max(0, targetSecs);
    return Math.round(clamped * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastItem?.id]);

  // Periodic drift-correction: every 12s, compare playhead against the live
  // broadcast position and snap forward/back if drift exceeds 4s. Uses a
  // single tolerance window so we don't fight micro-jitter from the player.
  useEffect(() => {
    if (!showBroadcast || !broadcastItem?.localVideoUrl || heroVideoFailed) return;
    const interval = setInterval(async () => {
      const ref = heroVideoRef.current;
      if (!ref || typeof ref.getStatusAsync !== "function") return;
      try {
        const status = await ref.getStatusAsync();
        if (!status?.isLoaded) return;
        const playheadSecs = (status.positionMillis ?? 0) / 1000;
        const drift = broadcastCurrent?.serverTimeMs
          ? (Date.now() - broadcastCurrent.serverTimeMs) / 1000
          : 0;
        const targetSecs = (broadcastCurrent?.positionSecs ?? 0) + drift;
        const dur = broadcastItem.durationSecs ?? 0;
        const clamped = dur > 0
          ? Math.max(0, Math.min(targetSecs, dur - 0.5))
          : Math.max(0, targetSecs);
        if (Math.abs(clamped - playheadSecs) > 4 && typeof ref.setPositionAsync === "function") {
          await ref.setPositionAsync(Math.round(clamped * 1000));
        }
      } catch {
        // Best-effort: drift correction failures are non-fatal.
      }
    }, 12000);
    return () => clearInterval(interval);
  }, [showBroadcast, broadcastItem?.id, broadcastItem?.localVideoUrl, broadcastItem?.durationSecs, broadcastCurrent?.positionSecs, broadcastCurrent?.serverTimeMs, heroVideoFailed]);

  // Reset failure flag when the broadcast pipeline advances to a new item.
  useEffect(() => {
    setHeroVideoFailed(false);
  }, [broadcastItem?.id]);

  const recentSermons = useMemo(() => sermons.slice(0, 6), [sermons]);
  const faithSermons = useMemo(() => sermons.filter((s) => s.category === "Faith").slice(0, 3), [sermons]);
  const healingSermons = useMemo(() => sermons.filter((s) => s.category === "Healing").slice(0, 3), [sermons]);
  const deliveranceSermons = useMemo(() => sermons.filter((s) => s.category === "Deliverance").slice(0, 3), [sermons]);
  const worshipSermons = useMemo(() => sermons.filter((s) => s.category === "Worship").slice(0, 3), [sermons]);
  const teachingsSermons = useMemo(() => sermons.filter((s) => s.category === "Teachings").slice(0, 3), [sermons]);
  const specialSermons = useMemo(() => sermons.filter((s) => s.category === "Special Programs").slice(0, 3), [sermons]);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <NetworkBanner visible={!isOnline} />

      <LiveNotificationBanner
        visible={showLiveBanner}
        title={BROADCAST_LIVE_BANNER_TITLE}
        onPress={() => {
          setShowLiveBanner(false);
          handleLivePress();
        }}
        onDismiss={() => {
          setShowLiveBanner(false);
          setLiveBannerDismissed(true);
        }}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 150 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={c.primary}
            colors={[c.primary]}
            progressBackgroundColor={c.card}
          />
        }
      >
        <Animated.View style={{ opacity: fadeAnim }}>

          {/* ─── Cinematic Hero ───────────────────────────────────────────────── */}
          {loading ? (
            <View style={{ paddingTop: topPad }}>
              <SkeletonLiveBanner />
            </View>
          ) : (
            <Pressable
              onPress={showBroadcast ? handleBroadcastPress : handleLivePress}
              style={({ pressed }) => [
                styles.cinemaHero,
                { height: heroHeight },
                pressed && { opacity: 0.93 },
              ]}
              accessible
              accessibilityRole="button"
              accessibilityLabel={effectiveLiveActive ? "Watch live service" : "Watch Temple TV"}
            >
              {/* Live-fallback flash banner — flashes for ~5 s when the live
                  YouTube embed for this device just dropped. Auto-clears via
                  the useLiveFallbackJustTriggered hook. */}
              {showLiveFallbackBanner && (
                <View
                  pointerEvents="none"
                  accessible
                  accessibilityRole="alert"
                  accessibilityLabel="Live unavailable, playing the broadcast queue instead"
                  style={styles.liveFallbackBanner}
                >
                  <View style={styles.liveFallbackDot} />
                  <Text style={styles.liveFallbackText} numberOfLines={2}>
                    Live unavailable — playing the broadcast queue instead
                  </Text>
                </View>
              )}

              {/* ── Backdrop: video > thumbnail > logo ── */}
              <View style={StyleSheet.absoluteFill}>
                {showBroadcast && broadcastItem?.localVideoUrl && HeroVideoComponent && !heroVideoFailed ? (
                  // Live broadcast surface — joins the 24/7 ON AIR timeline
                  // at the exact second currently airing rather than playing
                  // a looped preview. `key` remounts on item swap so the new
                  // queue item starts cleanly; `heroInitialPositionMillis`
                  // seeds the join point; the drift-correction effect calls
                  // setPositionAsync periodically to keep it in sync.
                  //
                  // Two-layer rendering (no cropping policy):
                  //  • Background: COVER mode + heavy blur (web only) — fills
                  //    the entire hero so we never see black letterbox bars,
                  //    but never displays a real frame the user is watching.
                  //  • Foreground: CONTAIN mode — preserves the full original
                  //    aspect ratio so no part of the broadcast is ever cut.
                  //
                  // On native, expo-av doesn't support CSS-style filters and
                  // running two video instances of the same source doubles
                  // bandwidth, so we render only the contain layer over the
                  // dark `cinemaHero` background — letterboxing is acceptable
                  // per the cinematic-broadcast spec and matches typical TV
                  // app behavior on phones.
                  <>
                    {Platform.OS === "web" && (
                      <HeroVideoComponent
                        key={`bg-${broadcastItem.id}`}
                        source={{ uri: broadcastItem.localVideoUrl }}
                        style={StyleSheet.absoluteFill}
                        resizeMode={HeroResizeMode?.COVER ?? "cover"}
                        isMuted
                        shouldPlay
                        useNativeControls={false}
                        progressUpdateIntervalMillis={10000}
                        positionMillis={heroInitialPositionMillis}
                        videoStyle={{
                          width: "100%",
                          height: "100%",
                          filter: "blur(28px) saturate(1.4) brightness(0.55)",
                          transform: "scale(1.08)",
                        } as any}
                      />
                    )}
                    <HeroVideoComponent
                      key={broadcastItem.id}
                      ref={heroVideoRef}
                      source={{ uri: broadcastItem.localVideoUrl }}
                      style={StyleSheet.absoluteFill}
                      resizeMode={HeroResizeMode?.CONTAIN ?? "contain"}
                      isMuted
                      shouldPlay
                      useNativeControls={false}
                      onError={() => setHeroVideoFailed(true)}
                      progressUpdateIntervalMillis={5000}
                      positionMillis={heroInitialPositionMillis}
                      videoStyle={{ width: "100%", height: "100%" }}
                    />
                  </>
                ) : showBroadcast && broadcastItem?.thumbnailUrl ? (
                  <Image source={{ uri: broadcastItem.thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : effectiveLiveActive && liveStatus.videoId && Platform.OS === "web" ? (
                  <View style={[StyleSheet.absoluteFill, { overflow: "hidden" as const }]}>
                    <LiveHeroPreviewIframe videoId={liveStatus.videoId} />
                  </View>
                ) : (
                  /* Off-air: branded gradient backdrop with subtle logo */
                  <View style={[StyleSheet.absoluteFill, styles.heroBrandedBg]}>
                    <Image
                      source={require("@/assets/images/logo.png")}
                      style={styles.heroLogoWatermark}
                      resizeMode="contain"
                    />
                  </View>
                )}
              </View>

              {/* ── Cinematic gradient overlay ── */}
              <LinearGradient
                colors={[
                  "rgba(0,0,0,0.68)",   // top — header legibility
                  "rgba(0,0,0,0.0)",    // upper-mid — let video breathe
                  "rgba(0,0,0,0.0)",    // lower-mid — let video breathe
                  "rgba(0,0,0,0.82)",   // bottom — content panel
                  "rgba(0,0,0,0.96)",   // very bottom — deep black
                ]}
                locations={[0, 0.22, 0.48, 0.78, 1]}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              {/* Side vignette for cinematic feel */}
              <LinearGradient
                colors={["rgba(0,0,0,0.42)", "rgba(0,0,0,0)", "rgba(0,0,0,0.3)"]}
                locations={[0, 0.5, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />

              {/* ── Floating Header ── */}
              <View style={[styles.heroHeader, { paddingTop: topPad + 10 }]}>
                <View style={styles.headerLogoWrap}>
                  <Image
                    source={require("@/assets/images/logo.png")}
                    style={styles.headerLogo}
                    resizeMode="contain"
                  />
                  <View style={styles.logoMeta}>
                    <Text style={styles.heroSubtitle}>JCTM Broadcasting</Text>
                    {isFromRss && !feedError && (
                      <View style={[styles.liveDot, { backgroundColor: "#22c55e" }]} />
                    )}
                    {!!feedError && !loading && (
                      <View style={[styles.liveDot, { backgroundColor: "#f59e0b" }]} />
                    )}
                  </View>
                </View>
                <Pressable
                  style={styles.heroSettingsBtn}
                  onPress={() => router.push("/(tabs)/settings")}
                  hitSlop={12}
                >
                  <Feather name="settings" size={20} color="rgba(255,255,255,0.85)" />
                </Pressable>
              </View>

              {/* ── Channel Bug (TV network-style watermark) ── */}
              {(showBroadcast || effectiveLiveActive) && (
                <View style={styles.channelBug}>
                  <Text style={styles.channelBugText}>TEMPLE TV</Text>
                </View>
              )}

              {/* ── Bottom content panel ── */}
              <View style={[styles.heroContent, { paddingBottom: Math.max(insets.bottom + 20, 28) }]}>
                {/* Status badge */}
                {!checkingLive && (
                  effectiveLiveActive ? (
                    <LiveBadge size="large" />
                  ) : showBroadcast ? (
                    <View style={styles.onAirBadge}>
                      <View style={styles.onAirPulse} />
                      <Text style={styles.onAirBadgeText}>ON AIR · TEMPLE TV</Text>
                    </View>
                  ) : (
                    <View style={styles.offlineBadge}>
                      <Feather name="tv" size={12} color="rgba(255,255,255,0.75)" />
                      <Text style={styles.offlineBadgeText}>24/7 STREAM</Text>
                    </View>
                  )
                )}

                {/* Title — three real-time states driven by the unified
                    live signal (SSE) so the hero flips instantly when the
                    broadcast starts/ends without a page refresh:
                      • effectiveLiveActive   → "Holy Spirit Sunday Service — Live Now"
                      • showScheduledLive     → "Live Service Coming Up"
                      • otherwise             → "Temple TV"
                    The live "Now" copy auto-disappears the moment
                    `liveStatus.isLive` flips false (broadcast ends or
                    content source switches), which the unified hook
                    receives over SSE within ~1 s. */}
                <Text style={styles.heroTitle} numberOfLines={2}>
                  {effectiveLiveActive
                    ? "Holy Spirit Sunday Service — Live Now"
                    : showScheduledLive
                    ? "Live Service Coming Up"
                    : "Temple TV"}
                </Text>

                {/* Subtitle — intentionally suppressed during the live
                    "Now" state so the combined title carries the message
                    on its own (per UX directive). When a scheduled live
                    service is starting soon, append the live countdown
                    so viewers can plan around it. */}
                {!effectiveLiveActive && (
                  <Text style={styles.heroSubtitleMeta}>
                    {showScheduledLive
                      ? liveCountdown
                        ? `Scheduled live service — ${liveCountdown.label.toLowerCase()}.`
                        : "Scheduled live service — tap to join."
                      : showBroadcast
                      ? "Spirit-filled broadcasts around the clock"
                      : "Temple TV Anywhere You Go"}
                  </Text>
                )}

                {/* Round 8: removed both the broadcast progress bar (Round 6)
                    and the "Up Next: <title>" chip. Per the broadcast-clean
                    directive, no queue metadata or upcoming-content text is
                    surfaced — the hero now reads as a pure TV-channel tease
                    with the live preview video carrying program identity. */}

                {/* CTA row */}
                <View style={styles.heroCtaRow}>
                  <Pressable
                    onPress={showBroadcast ? handleBroadcastPress : handleLivePress}
                    style={({ pressed }) => [
                      styles.heroWatchBtn,
                      { backgroundColor: effectiveLiveActive ? "#FF0040" : "#6A0DAD" },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Feather name="play" size={16} color="#FFF" />
                    <Text style={styles.heroWatchBtnText}>Watch Temple TV</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => router.push("/library")}
                    style={({ pressed }) => [styles.heroSecondaryBtn, pressed && { opacity: 0.75 }]}
                  >
                    <Feather name="grid" size={15} color="rgba(255,255,255,0.9)" />
                    <Text style={styles.heroSecondaryBtnText}>Library</Text>
                  </Pressable>
                </View>
              </View>
            </Pressable>
          )}

          <View style={styles.section}>
            <SectionHeader
              title="Latest Sermons"
              subtitle={isFromRss ? "From YouTube" : "Recently added"}
              onSeeAll={() => router.push("/library")}
            />
            {loading ? (
              <FlatList
                horizontal
                data={[1, 2, 3]}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
                keyExtractor={(item) => String(item)}
                renderItem={() => <SkeletonVerticalCard />}
              />
            ) : (
              <FlatList
                horizontal
                data={recentSermons}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
                keyExtractor={(item) => item.id}
                initialNumToRender={4}
                windowSize={5}
                removeClippedSubviews
                renderItem={({ item }) => (
                  <SermonCard sermon={item} onPress={handleSermonPress} variant="vertical" />
                )}
              />
            )}
          </View>

          {!loading && faithSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Faith" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Faith" } })} />
              <View style={styles.listContainer}>
                {faithSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && healingSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Healing & Miracles" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Healing" } })} />
              <View style={styles.listContainer}>
                {healingSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && deliveranceSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Deliverance" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Deliverance" } })} />
              <View style={styles.listContainer}>
                {deliveranceSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && worshipSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Worship" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Worship" } })} />
              <View style={styles.listContainer}>
                {worshipSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && teachingsSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Teachings" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Teachings" } })} />
              <View style={styles.listContainer}>
                {teachingsSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && specialSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Special Programs" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Special" } })} />
              <View style={styles.listContainer}>
                {specialSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {loading && (
            <View style={styles.section}>
              <View style={{ paddingHorizontal: 16 }}>
                <View style={{ height: 22, width: 120, backgroundColor: c.muted, borderRadius: 6, marginBottom: 12 }} />
              </View>
              <View style={styles.listContainer}>
                {[1, 2, 3].map((i) => <SkeletonHorizontalCard key={i} />)}
              </View>
            </View>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Cinematic Hero ───────────────────────────────────────────────────────────
  cinemaHero: {
    width: "100%",
    backgroundColor: "#060606",
    overflow: "hidden",
    position: "relative",
  },
  heroBrandedBg: {
    backgroundColor: "#0e0018",
    alignItems: "center",
    justifyContent: "center",
  },
  liveFallbackBanner: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 16,
    zIndex: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: "rgba(13, 17, 23, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.18)",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    alignSelf: "center",
  },
  liveFallbackDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#FF8A00",
  },
  liveFallbackText: {
    flexShrink: 1,
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  heroLogoWatermark: {
    width: 220,
    height: 70,
    opacity: 0.12,
  },

  // Floating header over the hero
  heroHeader: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 10,
    zIndex: 10,
  },
  headerLogoWrap: { flexDirection: "column", justifyContent: "center" },
  headerLogo: { width: 130, height: 40 },
  logoMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
  heroSubtitle: { fontSize: 11, fontFamily: "Inter_400Regular", letterSpacing: 1.2, color: "rgba(255,255,255,0.65)" },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  heroSettingsBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },

  // TV network-style channel bug (top-right watermark)
  channelBug: {
    position: "absolute",
    top: 0,
    right: 18,
    zIndex: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 0,
  },
  channelBugText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 3,
    color: "rgba(255,255,255,0.45)",
  },

  // Bottom content panel
  heroContent: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 10,
  },

  // Badges
  onAirBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(106,13,173,0.9)",
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(168,85,247,0.45)",
  },
  onAirPulse: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#a855f7",
  },
  onAirBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
  },
  offlineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.10)",
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  offlineBadgeText: { color: "rgba(255,255,255,0.8)", fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.8 },

  // Title & subtitle
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    lineHeight: 38,
    letterSpacing: -0.5,
    textShadowColor: "rgba(0,0,0,0.55)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  heroSubtitleMeta: {
    color: "rgba(255,255,255,0.80)",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },

  // CTA buttons row
  heroCtaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
  },
  heroWatchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 26,
  },
  heroWatchBtnText: { color: "#FFFFFF", fontSize: 15, fontFamily: "Inter_700Bold" },
  heroSecondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 26,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  heroSecondaryBtnText: { color: "rgba(255,255,255,0.9)", fontSize: 14, fontFamily: "Inter_600SemiBold" },

  // Shared / left-overs
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", letterSpacing: 1 },
  notifBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  section: { marginTop: 28, gap: 12 },
  listContainer: { paddingHorizontal: 16, gap: 10 },
});

/**
 * Web-only YouTube live preview iframe with failure detection — mobile
 * twin of `LiveHeroPreviewIframe` in `artifacts/tv/src/components/LiveHero.tsx`.
 *
 * Why a watchdog: the YouTube embed is a cross-origin iframe and its
 * `error` event is unreliable for the failure modes we care about
 * (geo-block, embedding disabled, age-restricted). If the iframe hasn't
 * fired `onload` within MOBILE_LIVE_HERO_LOAD_TIMEOUT_MS, we treat it
 * as a failure. Reporting the failure flips `effectiveLiveActive` to
 * false here AND in the player on the same device, so both surfaces
 * fall through to the broadcast queue together.
 */
const MOBILE_LIVE_HERO_LOAD_TIMEOUT_MS = 12_000;

function LiveHeroPreviewIframe({ videoId }: { videoId: string }) {
  const loadedRef = useRef(false);
  useEffect(() => {
    loadedRef.current = false;
    const watchdog = setTimeout(() => {
      if (!loadedRef.current) reportLiveFailure(videoId, "mobile-hero");
    }, MOBILE_LIVE_HERO_LOAD_TIMEOUT_MS);
    return () => clearTimeout(watchdog);
  }, [videoId]);

  // Render a real DOM iframe — Platform.OS === "web" is already gated
  // by the caller, so this only runs in the browser bundle.
  return React.createElement("iframe", {
    key: videoId,
    src: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&loop=1&playlist=${videoId}&rel=0&iv_load_policy=3`,
    allow: "autoplay; encrypted-media",
    frameBorder: 0,
    onLoad: () => { loadedRef.current = true; },
    onError: () => reportLiveFailure(videoId, "mobile-hero"),
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      border: 0,
      pointerEvents: "none",
    },
    title: "Temple TV Live Preview",
  });
}
