/**
 * Home / Watch Screen — Temple TV Mobile
 *
 * Production-grade home screen. All content is API-driven:
 *  • Live broadcast state via V2 player-core singleton (WS transport)
 *  • Video catalog via useVideos (GET /api/videos, AsyncStorage cache)
 *
 * Layout (immersive — no redundant app header above the video):
 *  1. Live broadcast hero — extends under the system status bar; a dark
 *     top-gradient protects status-bar readability while keeping the full
 *     video area visible. A floating logo overlay sits inside the hero so
 *     the brand is present without consuming a separate header row.
 *  2. Category rows (Live Service, Sermons, Deliverance, Prayers, …)
 *  3. Error / empty states
 */

import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useVideos } from "@/hooks/useVideos";
import { VideoCard } from "@/components/VideoCard";
import { SectionHeader } from "@/components/SectionHeader";
import { SkeletonVerticalCard, SkeletonHero } from "@/components/SkeletonCard";
import { V2PlayerContainer } from "@/components/V2PlayerContainer";
import { StreamStatusBadge } from "@/components/StreamStatusBadge";
import { getApiBase } from "@/lib/apiBase";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import { usePlayer } from "@/context/PlayerContext";
import { useBroadcastSync } from "@/hooks/useBroadcastSync";
import { useMediaPlayerState } from "@/hooks/useMediaPlayerState";
import type { Sermon, SermonCategory } from "@/types";
import { useWatchProgress, type ContinueWatchingItem } from "@/hooks/useWatchProgress";

const CATEGORY_ROWS: SermonCategory[] = [
  "Live Service",
  "Sermons",
  "Deliverance",
  "Prayers",
  "Crusades",
  "Conferences",
  "Testimonies",
];

// ─── Navigation helpers ───────────────────────────────────────────────────────

function navigateToSermon(sermon: Sermon) {
  router.push({
    pathname: "/player",
    params: {
      id: sermon.id,
      title: sermon.title,
      youtubeId: sermon.videoSource === "youtube" ? sermon.youtubeId : "",
      // Pass HLS and MP4 URLs as separate params so the player can do
      // MP4-first selection: hlsUrl preferred when available, localVideoUrl
      // used directly when HLS has not yet been transcoded.
      hlsUrl: sermon.hlsMasterUrl ?? "",
      localVideoUrl: sermon.localVideoUrl ?? "",
      thumbnailUrl: sermon.thumbnailUrl,
      preacher: sermon.preacher,
      duration: sermon.duration,
      category: sermon.category,
      description: sermon.description,
    },
  });
}

function navigateToLive(
  hlsUrl: string,
  title: string,
  positionSecs: number,
  youtubeId?: string,
  thumbnailUrl?: string,
) {
  router.push({
    pathname: "/player",
    params: {
      id: "live",
      title,
      hlsUrl,
      youtubeId: youtubeId ?? "",
      thumbnailUrl: thumbnailUrl ?? "",
      isLive: "true",
      startPositionSecs: String(Math.max(0, Math.round(positionSecs))),
    },
  });
}

// ─── Ministry Header ──────────────────────────────────────────────────────────
// Sits above the hero, owns the safe-area top inset so the hero no longer
// extends under the status bar. Provides clear brand identity at the very top.

interface MinistryHeaderProps {
  topInset: number;
}

function MinistryHeader({ topInset }: MinistryHeaderProps) {
  const c = useColors();
  return (
    <View
      style={[
        styles.ministryHeader,
        { paddingTop: topInset + 10, backgroundColor: c.background },
      ]}
    >
      <Text style={[styles.ministryTitle, { color: c.foreground }]}>
        Jesus Christ Temple Ministry
      </Text>
      <View style={[styles.ministryDivider, { backgroundColor: c.primary }]} />
    </View>
  );
}

// ─── Now Playing Mini-bar ─────────────────────────────────────────────────────
// Floats above the tab bar when the hero is unmuted AND a live (non-YouTube)
// broadcast is running. Lets the viewer tap to jump to the full player without
// losing their scroll position in the catalog, or tap the speaker to silence
// the preview from anywhere on the screen.

interface NowPlayingMiniBarProps {
  heroMuted: boolean;
  onMuteToggle: () => void;
  bottomInset: number;
}

const NowPlayingMiniBar = React.memo(function NowPlayingMiniBar({
  heroMuted,
  onMuteToggle,
  bottomInset,
}: NowPlayingMiniBarProps) {
  const c = useColors();
  const apiBase = getApiBase() ?? "";
  const { snapshot: v2Snapshot } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });
  const v2Server = v2Snapshot.lastServerSnapshot;

  const hasActiveBroadcast = !!(
    v2Server?.current && v2Server.current.source?.kind !== "youtube"
  );

  // ── Slide animation ────────────────────────────────────────────────────────
  // translateY: 0 = fully visible, +80 = hidden below tab bar.
  const slideY   = useRef(new Animated.Value(80)).current;
  const visible  = !heroMuted && hasActiveBroadcast;
  const prevRef  = useRef(false);

  useEffect(() => {
    if (visible === prevRef.current) return;
    prevRef.current = visible;
    Animated.spring(slideY, {
      toValue: visible ? 0 : 80,
      useNativeDriver: true,
      damping: 18,
      stiffness: 220,
    }).start();
  }, [visible, slideY]);

  // Don't bother rendering the subtree when the bar is and has always been hidden.
  if (!visible && !prevRef.current) return null;

  const title = v2Server?.current?.title ?? "Live Broadcast";
  const thumbUrl = v2Server?.current?.thumbnailUrl ?? null;

  const handleOpen = () => {
    navigateToLive("", title, 0, undefined, thumbUrl ?? undefined);
  };

  const BAR_HEIGHT  = 62;
  const BOTTOM_GAP  = bottomInset + 8; // sit just above the tab bar safe zone

  return (
    <Animated.View
      style={[
        styles.miniBarWrapper,
        { transform: [{ translateY: slideY }], bottom: BOTTOM_GAP },
      ]}
      pointerEvents={visible ? "box-none" : "none"}
    >
      <Pressable
        onPress={handleOpen}
        style={[
          styles.miniBar,
          { height: BAR_HEIGHT, backgroundColor: c.card, borderColor: c.border },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Now playing: ${title}. Tap to open player.`}
      >
        {/* Thumbnail */}
        {thumbUrl ? (
          <Image
            source={{ uri: thumbUrl }}
            style={styles.miniBarThumb}
          />
        ) : (
          <View style={[styles.miniBarThumb, { backgroundColor: c.muted }]}>
            <Feather name="radio" size={18} color={c.mutedForeground} />
          </View>
        )}

        {/* Title + LIVE badge */}
        <View style={styles.miniBarInfo}>
          <View style={styles.miniBarLiveRow}>
            <View style={styles.miniBarLiveDot} />
            <Text style={styles.miniBarLiveText}>LIVE</Text>
          </View>
          <Text
            style={[styles.miniBarTitle, { color: c.foreground }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {title}
          </Text>
        </View>

        {/* Controls: mute + open-player chevron */}
        <View style={styles.miniBarControls}>
          <Pressable
            onPress={(e) => { e.stopPropagation?.(); onMuteToggle(); }}
            hitSlop={10}
            style={styles.miniBarMuteBtn}
            accessibilityRole="button"
            accessibilityLabel={heroMuted ? "Unmute" : "Mute"}
          >
            <Feather
              name={heroMuted ? "volume-x" : "volume-2"}
              size={18}
              color={c.foreground}
            />
          </Pressable>
          <Feather name="chevron-up" size={18} color={c.mutedForeground} />
        </View>
      </Pressable>
    </Animated.View>
  );
});

// ─── Hero Section ─────────────────────────────────────────────────────────────
// The hero sits below the MinistryHeader — topInset is 0 because the header
// above already handles the safe-area top inset.
// topInset is kept as a prop (always 0 from WatchScreen) so the internal
// overlay positioning logic (logo, emergency banner, gradient) still reads
// consistently without requiring a wider refactor.
//
// heroMuted + onMuteToggle are lifted to WatchScreen so the NowPlayingMiniBar
// can also read and toggle the same mute state from anywhere on the page.

interface HeroSectionProps {
  fallbackSermon: Sermon | null;
  topInset: number;
  heroMuted: boolean;
  onMuteToggle: () => void;
}

const HeroSection = React.memo(function HeroSection({
  fallbackSermon,
  topInset,
  heroMuted,
  onMuteToggle,
}: HeroSectionProps) {
  const c = useColors();
  // isBroadcastMode comes from the singleton player — used to suppress hero
  // watchdog events when the full-screen player is open so they don't race.
  const { isBroadcastMode } = usePlayer();
  const { width } = useWindowDimensions();
  // True 16:9 video area + status-bar region above it = total hero height.
  // This lets the video fill the space that was previously occupied by the
  // redundant app header, maximising visible video area.
  const videoHeight = Math.round(width * 0.5625);
  const totalHeroHeight = videoHeight + topInset;
  const apiBase = getApiBase() ?? "";

  // V2 FSM singleton — attaches a React listener to the already-running session.
  // Declared first so heroProgress + hasActiveBroadcast can reference v2Server.
  // No extra WS connection — hooks into the same singleton used by V2PlayerContainer.
  const { snapshot: v2Snapshot, forceRebind } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });
  const v2Server = v2Snapshot.lastServerSnapshot;

  // STRICT POLICY: YouTube items are never promoted to the hero.
  // Only uploaded/local platform broadcasts get the hero treatment.
  // Declared early so heroProgress effect below can read it.
  const hasUploadedBroadcast = !!(
    v2Server?.current && v2Server.current.source?.kind !== "youtube"
  );
  const hasActiveBroadcast = hasUploadedBroadcast;

  // ── Hero live progress bar ─────────────────────────────────────────────────
  // Tracks how far into the current broadcast item we are: 0 = start, 1 = end.
  // Ticks every second using the client clock against the V2 snapshot's
  // startsAtMs (negligible server-client offset for a display bar). Resets
  // automatically when the current item advances (v2Server.current.id changes).
  const [heroProgress, setHeroProgress] = useState(0);

  useEffect(() => {
    const current = v2Server?.current;
    if (!hasActiveBroadcast || !current?.startsAtMs || !current?.durationSecs) {
      setHeroProgress(0);
      return;
    }
    const { startsAtMs, durationSecs } = current;
    const tick = () => {
      const elapsedSecs = Math.max(0, (Date.now() - startsAtMs) / 1000);
      setHeroProgress(Math.min(1, elapsedSecs / Math.max(1, durationSecs)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveBroadcast, v2Server?.current?.id]);

  // Unified media state — drives badge, CTA, and status indicators.
  const {
    mediaState,
    isWatchLiveCTAVisible,
    isReconnecting,
    isFatal,
  } = useMediaPlayerState();

  // ── Hero skeleton (initial broadcast connection) ───────────────────────────
  // Show the skeleton only during the very first connection attempt — once we
  // receive ANY server snapshot (live or off-air) we fade it out and never show
  // it again (reconnection flicker is handled by the existing content layer).
  const skeletonOpacity = useRef(new Animated.Value(1)).current;
  const [showSkeletonLayer, setShowSkeletonLayer] = useState(true);

  useEffect(() => {
    if (v2Server !== null && showSkeletonLayer) {
      Animated.timing(skeletonOpacity, {
        toValue: 0,
        duration: 450,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setShowSkeletonLayer(false);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2Server]);

  // Safety-net: if the WS connection never delivers a snapshot (no API URL,
  // network issue, etc.) dismiss the skeleton after 8 s so the hero still
  // renders the fallback sermon poster / gradient instead of staying blank.
  useEffect(() => {
    const t = setTimeout(() => {
      if (showSkeletonLayer) {
        Animated.timing(skeletonOpacity, {
          toValue: 0,
          duration: 450,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished) setShowSkeletonLayer(false);
        });
      }
    }, 8_000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live viewer count + OMEGA emergency signal from the v1 broadcast sync heartbeat.
  // V2Snapshot (player-core) does not carry viewer counts or OMEGA signals — those
  // are pushed by the v1 WS gateway and surfaced via useBroadcastSync.
  // Must be declared BEFORE the emergency-pulse useEffect so `emergencyBroadcast`
  // is not in the Temporal Dead Zone when React evaluates the dependency array.
  const syncState = useBroadcastSync();
  const { viewerCount, emergencyMessage } = syncState;

  // Animated pulse for the OMEGA emergency banner — draws urgent attention.
  const emergencyPulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!syncState.emergencyBroadcast) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(emergencyPulseAnim, { toValue: 0.6, duration: 400, useNativeDriver: true }),
        Animated.timing(emergencyPulseAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [syncState.emergencyBroadcast, emergencyPulseAnim]);

  // Thumbnail: broadcast thumbnail > fallback sermon poster > null (gradient only).
  const thumbUrl =
    hasUploadedBroadcast && v2Server?.current?.thumbnailUrl
      ? v2Server.current.thumbnailUrl
      : fallbackSermon?.thumbnailUrl ?? null;

  // Disable both Pressables when there is genuinely nothing to navigate to.
  const watchNowDisabled = !hasActiveBroadcast && !fallbackSermon;

  const handleTuneIn = useCallback(() => {
    if (hasActiveBroadcast) {
      navigateToLive("", "Live Broadcast", 0, undefined, thumbUrl ?? undefined);
    } else if (fallbackSermon) {
      navigateToSermon(fallbackSermon);
    }
  }, [hasActiveBroadcast, fallbackSermon, thumbUrl]);

  return (
    <Pressable
      onPress={handleTuneIn}
      disabled={watchNowDisabled}
      style={{ width, height: totalHeroHeight }}
      accessibilityRole="button"
      accessibilityLabel={hasActiveBroadcast ? "Watch Now — live broadcast" : "Watch latest sermon"}
      accessibilityState={{ disabled: watchNowDisabled }}
    >
      {/* Base layer — ambient blurred fill covers any letterbox/pillarbox areas
          produced by the contained sharp thumbnail, so there are no harsh
          black bars. Mirrors the pattern used in V2PlayerContainer's poster. */}
      {thumbUrl && (
        <Image
          source={{ uri: thumbUrl }}
          style={[StyleSheet.absoluteFill, { opacity: 0.5 }]}
          contentFit="cover"
          blurRadius={25}
          accessible={false}
        />
      )}
      {/* Sharp thumbnail — contained so the full video frame is always visible
          without cropping, matching the V2 player's ResizeMode.CONTAIN behaviour. */}
      {thumbUrl && (
        <Image
          source={{ uri: thumbUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
        />
      )}

      {/* V2 broadcast video — ALWAYS mounted (muted by default, minimal) to keep the
          singleton FSM session warm. pointerEvents="none" lets hero touch events pass
          through to the Pressable.
          suppressEventsOverride=isBroadcastMode: when the player screen is open, the
          full-screen player instance is the sole FSM driver — suppress watchdogs/events
          from the hero so it can't fire spurious buffer-error/stall that interrupt the
          player. heroMuted is reset to true automatically when isBroadcastMode becomes
          true, preventing audio bleed between hero preview and the full player. */}
      <View style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
        <V2PlayerContainer
          baseUrl={`${apiBase}/api/broadcast-v2`}
          muted={heroMuted}
          minimal
          suppressEventsOverride={isBroadcastMode}
        />
      </View>

      {/* ── Mute / Unmute toggle — top-right corner ──────────────────────────
          Only shown when there is an active non-YouTube broadcast playing (so
          the user has real audio to control). Positioned as a sibling of the
          pointerEvents="none" layers so its own Pressable receives touches;
          the inner Pressable stops propagation, preventing the outer hero
          Pressable from also firing navigateToLive. */}
      {hasActiveBroadcast && !isBroadcastMode && (
        <Pressable
          onPress={onMuteToggle}
          style={({ pressed }) => [
            styles.heroMuteBtn,
            { top: topInset + 8, opacity: pressed ? 0.72 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={heroMuted ? "Unmute live preview" : "Mute live preview"}
          hitSlop={10}
        >
          <Feather
            name={heroMuted ? "volume-x" : "volume-2"}
            size={16}
            color="#fff"
          />
        </Pressable>
      )}

      {/* ── Top gradient — protects status-bar icon readability ──────────────
          Explicit absolute position (NOT StyleSheet.absoluteFill) so that the
          `height` constraint is respected without `bottom: 0` fighting it.
          Dark enough to keep clock/battery icons legible against any video,
          subtle enough not to obscure the content below. */}
      <LinearGradient
        colors={["rgba(0,0,0,0.55)", "rgba(0,0,0,0.20)", "transparent"]}
        locations={[0, 0.55, 1]}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: topInset + 72,
        }}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        pointerEvents="none"
      />

      {/* ── Bottom gradient — text-legibility behind badges + CTA ─────────── */}
      <LinearGradient
        colors={[
          "transparent",
          "transparent",
          "rgba(0,0,0,0.5)",
          "rgba(0,0,0,0.92)",
        ]}
        locations={[0, 0.25, 0.62, 1]}
        style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
      >
        <View style={styles.heroContent}>
          {/* ── Badges row ── */}
          <View style={styles.heroBadges}>
            {/* Unified stream status badge — live/loading/reconnecting/offline/error */}
            <StreamStatusBadge
              state={mediaState}
              variant="compact"
              hideWhenIdle={!hasActiveBroadcast}
            />

            {hasActiveBroadcast && viewerCount != null && viewerCount > 0 && (
              <View style={styles.viewerBadge}>
                <Feather name="users" size={9} color="rgba(255,255,255,0.75)" />
                <Text style={styles.viewerText}>
                  {viewerCount >= 1000
                    ? `${(viewerCount / 1000).toFixed(1)}k`
                    : String(viewerCount)}{" watching"}
                </Text>
              </View>
            )}

            {!hasActiveBroadcast && fallbackSermon?.category && (
              <View style={[styles.categoryBadge, { backgroundColor: c.primary + "cc" }]}>
                <Text style={styles.categoryBadgeText}>{fallbackSermon.category}</Text>
              </View>
            )}
          </View>

          {/* ── CTA / Reconnect button ──
              Priority order:
              1. isFatal → "Reconnect" button calls forceRebind() to fully reload transport.
              2. isWatchLiveCTAVisible (idle / offline / error) → "Watch Live" / "Watch Now".
              3. Active broadcast, not reconnecting → quiet "Open Player" secondary button.
              While reconnecting, no button is shown — the StreamStatusBadge provides feedback. */}
          {isFatal ? (
            <Pressable
              onPress={forceRebind}
              style={({ pressed }) => [
                styles.heroBtn,
                { backgroundColor: "#DC2626", opacity: pressed ? 0.85 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Reconnect to live broadcast"
            >
              <Feather name="refresh-cw" size={13} color="#fff" />
              <Text style={styles.heroBtnText}>Reconnect</Text>
            </Pressable>
          ) : !watchNowDisabled && isWatchLiveCTAVisible ? (
            <Pressable
              onPress={handleTuneIn}
              style={({ pressed }) => [
                styles.heroBtn,
                { backgroundColor: c.primary, opacity: pressed ? 0.88 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={hasActiveBroadcast ? "Watch live broadcast" : "Watch sermon"}
            >
              <Feather name="play" size={13} color="#fff" />
              <Text style={styles.heroBtnText}>
                {hasActiveBroadcast ? "Watch Live" : "Watch Now"}
              </Text>
            </Pressable>
          ) : !watchNowDisabled && !isWatchLiveCTAVisible && !isReconnecting ? (
            <Pressable
              onPress={handleTuneIn}
              style={({ pressed }) => [
                styles.heroBtnSecondary,
                { borderColor: "rgba(255,255,255,0.45)", opacity: pressed ? 0.78 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Open broadcast player"
            >
              <Feather name="maximize-2" size={13} color="#fff" />
              <Text style={styles.heroBtnSecondaryText}>Open Player</Text>
            </Pressable>
          ) : null}
        </View>
      </LinearGradient>

      {/* ── Floating logo overlay ─────────────────────────────────────────────
          Positioned inside the hero, below the notch/status-bar area.
          Establishes brand context without occupying a separate header row.
          pointerEvents="none" — taps pass through to the Pressable beneath. */}
      <View
        style={[styles.heroTopBar, { paddingTop: topInset + 10 }]}
        pointerEvents="none"
      >
        <Image
          source={require("@/assets/images/temple-tv-logo-full.png")}
          style={styles.heroLogo}
          contentFit="contain"
          accessible
          accessibilityLabel="App logo"
        />
      </View>

      {/* ── OMEGA emergency broadcast banner ────────────────────────────────────
          Rendered above all other hero layers (zIndex 30) when the server fires
          an EMERGENCY_BROADCAST signal via the v1 WS gateway. Cleared on the
          next PROGRAM_CHANGED event. Positioned below the notch so it never
          clips behind the status bar. pointerEvents="none" — taps still reach
          the underlying Pressable so the viewer can navigate to the player. */}
      {syncState.emergencyBroadcast && (
        <Animated.View
          style={[
            styles.emergencyBanner,
            { top: topInset, opacity: emergencyPulseAnim },
          ]}
          pointerEvents="none"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <Feather name="alert-triangle" size={13} color="#fff" />
          <Text style={styles.emergencyBannerTitle}>EMERGENCY BROADCAST</Text>
          {!!emergencyMessage && (
            <Text style={styles.emergencyBannerMsg} numberOfLines={1}>
              {emergencyMessage}
            </Text>
          )}
        </Animated.View>
      )}

      {/* ── Live progress bar — bottom edge of hero ─────────────────────────
          Shows broadcast position (elapsed / total duration) so viewers see at
          a glance how far into the current item the broadcast is. Hidden when
          off-air or no active non-YouTube broadcast. pointerEvents="none"
          so hero taps still navigate to the player. */}
      {hasActiveBroadcast && v2Server?.current && (
        <View style={styles.heroProgressTrack} pointerEvents="none">
          <View
            style={[
              styles.heroProgressFill,
              // Use % width — flexbox resolves it correctly on RN.
              // eslint-disable-next-line react-native/no-inline-styles
              { width: `${Math.round(heroProgress * 100)}%` },
            ]}
          />
        </View>
      )}

      {/* ── Hero skeleton overlay ──────────────────────────────────────────────
          Fades out the first time lastServerSnapshot becomes non-null.
          pointerEvents="none" so the underlying Pressable stays tappable even
          during the brief fade-out window. */}
      {showSkeletonLayer && (
        <Animated.View
          style={[StyleSheet.absoluteFill, { opacity: skeletonOpacity, zIndex: 20 }]}
          pointerEvents="none"
        >
          <SkeletonHero />
        </Animated.View>
      )}
    </Pressable>
  );
});

// ─── Continue Watching Row ────────────────────────────────────────────────────

function formatProgress(pct: number): string {
  return `${Math.round(pct * 100)}% watched`;
}

function formatSecondsLeft(position: number, duration: number): string {
  const left = Math.max(0, duration - position);
  if (left < 60) return `${Math.round(left)}s left`;
  if (left < 3600) return `${Math.round(left / 60)}m left`;
  return `${Math.floor(left / 3600)}h ${Math.round((left % 3600) / 60)}m left`;
}

interface ContinueWatchingRowProps {
  items: ContinueWatchingItem[];
}

const ContinueWatchingRow = React.memo(function ContinueWatchingRow({
  items,
}: ContinueWatchingRowProps) {
  const c = useColors();
  const { width: screenWidth } = useWindowDimensions();

  if (items.length === 0) return null;

  // Card is wider than category cards: one-and-a-half cards visible so the
  // user knows there's more to scroll. Clamp to reasonable bounds.
  const cardWidth = Math.min(Math.max(200, Math.round(screenWidth * 0.52)), 280);
  const thumbHeight = Math.round(cardWidth * (9 / 16));

  return (
    <View style={styles.rowContainer}>
      <SectionHeader title="Continue Watching" />
      <FlatList
        horizontal
        data={items}
        keyExtractor={(item) => item.videoKey}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowContent}
        ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
        renderItem={({ item }) => {
          const hasThumb = !!item.thumbnailUrl;
          return (
            <Pressable
              onPress={() => {
                if (item.hlsMasterUrl || item.localVideoUrl) {
                  router.push({
                    pathname: "/player",
                    params: {
                      id: item.videoKey,
                      title: item.title ?? "Continue watching",
                      hlsUrl: item.hlsMasterUrl ?? "",
                      localVideoUrl: item.localVideoUrl ?? "",
                      youtubeId: item.youtubeId ?? "",
                      thumbnailUrl: item.thumbnailUrl ?? "",
                      startPositionSecs: String(Math.max(0, Math.round(item.position - 3))),
                    },
                  });
                } else if (item.youtubeId) {
                  router.push({
                    pathname: "/player",
                    params: {
                      id: item.videoKey,
                      title: item.title ?? "Continue watching",
                      youtubeId: item.youtubeId,
                      thumbnailUrl: item.thumbnailUrl ?? "",
                      startPositionSecs: String(Math.max(0, Math.round(item.position - 3))),
                    },
                  });
                }
              }}
              style={({ pressed }) => [
                styles.cwCard,
                { width: cardWidth, backgroundColor: c.card, opacity: pressed ? 0.82 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Continue watching ${item.title ?? "video"}, ${formatProgress(item.pct)}`}
            >
              {/* Thumbnail */}
              <View style={[styles.cwThumb, { width: cardWidth, height: thumbHeight }]}>
                {hasThumb ? (
                  <Image
                    source={{ uri: item.thumbnailUrl }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                  />
                ) : (
                  <View style={[StyleSheet.absoluteFill, { backgroundColor: c.muted, alignItems: "center", justifyContent: "center" }]}>
                    <Feather name="video" size={28} color={c.mutedForeground} />
                  </View>
                )}
                {/* Play icon overlay */}
                <View style={styles.cwPlayOverlay}>
                  <View style={[styles.cwPlayBtn, { backgroundColor: "rgba(0,0,0,0.68)" }]}>
                    <Feather name="play" size={16} color="#fff" />
                  </View>
                </View>
                {/* Time remaining chip */}
                {item.duration > 0 && (
                  <View style={styles.cwTimeChip}>
                    <Text style={styles.cwTimeText}>
                      {formatSecondsLeft(item.position, item.duration)}
                    </Text>
                  </View>
                )}
              </View>
              {/* Progress bar — flex-based so no pixel math required */}
              <View style={[styles.cwProgressTrack, { backgroundColor: c.border }]}>
                <View style={{ flex: item.pct, height: 3, backgroundColor: c.primary, borderRadius: 2 }} />
                <View style={{ flex: 1 - item.pct, height: 3 }} />
              </View>
              {/* Title */}
              {!!item.title && (
                <Text
                  style={[styles.cwTitle, { color: c.foreground }]}
                  numberOfLines={2}
                >
                  {item.title}
                </Text>
              )}
            </Pressable>
          );
        }}
      />
    </View>
  );
});

// ─── Category Row ─────────────────────────────────────────────────────────────

const CategoryRow = React.memo(function CategoryRow({
  category,
  sermons,
}: {
  category: SermonCategory;
  sermons: Sermon[];
}) {
  if (sermons.length === 0) return null;

  return (
    <View style={styles.rowContainer}>
      <SectionHeader title={category} />
      <FlatList
        horizontal
        data={sermons.slice(0, 10)}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowContent}
        ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
        renderItem={({ item }) => (
          <VideoCard
            sermon={item}
            onPress={() => navigateToSermon(item)}
          />
        )}
      />
    </View>
  );
});

// ─── Skeleton Rows ────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <View style={{ gap: 32 }}>
      {[0, 1, 2].map((i) => (
        <View key={i}>
          <View style={styles.skeletonHeader} />
          <FlatList
            horizontal
            data={[1, 2, 3, 4]}
            keyExtractor={(k) => String(k)}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rowContent}
            ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
            renderItem={() => <SkeletonVerticalCard />}
          />
        </View>
      ))}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
// The Watch screen is intentionally headerless — the live video is the primary
// content and should command the full visual space from the top of the screen.
// Brand context is provided by the floating logo overlay inside the hero itself.

export default function WatchScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isOnline: networkConnected } = useNetworkStatus();
  const { isBroadcastMode } = usePlayer();

  const { sermons, byCategory, loading, error, refetch, isStale, refreshFailed } = useVideos();
  const { continueWatching } = useWatchProgress();

  // ── Hero mute state (lifted here so NowPlayingMiniBar can share it) ────────
  // Default: muted. User unmutes via the hero speaker button or mini-bar.
  // Auto-resets when the full player opens (isBroadcastMode) to prevent bleed.
  const [heroMuted, setHeroMuted] = useState(true);
  useEffect(() => {
    if (isBroadcastMode) setHeroMuted(true);
  }, [isBroadcastMode]);
  const handleMuteToggle = useCallback(() => setHeroMuted((p) => !p), []);

  // Hero fallback — prefer a local sermon with a thumbnail so the hero is
  // never a bare gradient. YouTube-sourced items are explicitly excluded.
  const fallbackSermon = useMemo<Sermon | null>(() => {
    const localOnly = sermons.filter((s) => s.videoSource === "local");
    return (
      localOnly.find((s) => !!s.thumbnailUrl) ??
      localOnly[0] ??
      null
    );
  }, [sermons]);

  const categoryRows = useMemo(
    () =>
      CATEGORY_ROWS.map((cat) => ({
        category: cat,
        sermons: byCategory[cat] ?? [],
      })).filter((row) => row.sermons.length > 0),
    [byCategory],
  );

  const isRefreshing = loading && sermons.length > 0;

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      {/* No ScreenHeader here — the Watch screen is fully immersive.
          The hero extends under the system status bar; the floating logo
          overlay inside the hero provides brand context. */}

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={refetch}
            tintColor={c.primary}
          />
        }
      >
        {/* Ministry header — owns the safe-area top inset; hero sits below */}
        <MinistryHeader topInset={insets.top} />

        {/* Hero — topInset=0 because the header above handles the safe area */}
        <HeroSection
          fallbackSermon={fallbackSermon}
          topInset={0}
          heroMuted={heroMuted}
          onMuteToggle={handleMuteToggle}
        />

        {/* Stale cache banner — inside ScrollView so it never floats over video.
            Three states:
            1. isStale + refreshing:  "Showing cached content — refreshing…"
            2. isStale + failed:      "Couldn't refresh — showing saved content" + retry
            3. offline:               hidden (NetworkBanner already covers this) */}
        {isStale && !loading && networkConnected && (
          <View style={[
            styles.staleBanner,
            refreshFailed && styles.staleBannerFailed,
          ]}>
            <Feather
              name={refreshFailed ? "wifi-off" : "clock"}
              size={11}
              color={refreshFailed ? "#991b1b" : "#92400e"}
            />
            <Text style={[
              styles.staleBannerText,
              refreshFailed && styles.staleBannerTextFailed,
            ]}>
              {refreshFailed
                ? "Couldn't refresh — showing saved content"
                : "Showing cached content — refreshing…"}
            </Text>
            {refreshFailed && (
              <Pressable
                onPress={refetch}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Retry loading videos"
              >
                <Text style={styles.staleBannerRetry}>Retry</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Error state */}
        {error && sermons.length === 0 && (
          <View style={[styles.errorWrap, { backgroundColor: c.card, borderColor: c.border }]}>
            <Feather name="wifi-off" size={32} color={c.mutedForeground} />
            <Text style={[styles.errorTitle, { color: c.foreground }]}>
              Couldn't load videos
            </Text>
            <Text style={[styles.errorDesc, { color: c.mutedForeground }]}>
              {error}
            </Text>
            <Pressable
              onPress={refetch}
              style={[styles.retryBtn, { backgroundColor: c.primary }]}
            >
              <Text style={styles.retryText}>Try Again</Text>
            </Pressable>
          </View>
        )}

        {/* Content: skeletons or category rows */}
        <View style={styles.content}>
          {loading && sermons.length === 0 ? (
            <SkeletonRows />
          ) : (
            <>
              {/* Continue Watching — shown before category rows whenever the
                  user has partially-watched videos saved locally. Hidden when
                  the list is empty (hook returns [] by default). */}
              <ContinueWatchingRow items={continueWatching} />

              {categoryRows.map(({ category, sermons: catSermons }) => (
                <CategoryRow
                  key={category}
                  category={category}
                  sermons={catSermons}
                />
              ))}

              {categoryRows.length === 0 && !loading && !error && (
                <View style={styles.emptyState}>
                  <Feather name="tv" size={48} color={c.mutedForeground} />
                  <Text style={[styles.emptyTitle, { color: c.foreground }]}>
                    No videos yet
                  </Text>
                  <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
                    Sermons will appear here once uploaded
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {/* ── Now Playing mini-bar ────────────────────────────────────────────────
          Floats above the tab bar when hero is unmuted + live broadcast running.
          Rendered outside the ScrollView so it stays fixed while the catalog
          scrolls underneath. */}
      <NowPlayingMiniBar
        heroMuted={heroMuted}
        onMuteToggle={handleMuteToggle}
        bottomInset={insets.bottom}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Now Playing mini-bar ─────────────────────────────────────────────────────
  miniBarWrapper: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 50,
  },
  miniBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 10,
    // Shadow (iOS)
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    // Elevation (Android)
    elevation: 8,
  },
  miniBarThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
  },
  miniBarInfo: {
    flex: 1,
    justifyContent: "center",
    gap: 2,
  },
  miniBarLiveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  miniBarLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#ef4444",
  },
  miniBarLiveText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#ef4444",
    letterSpacing: 0.8,
  },
  miniBarTitle: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  miniBarControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
  },
  miniBarMuteBtn: {
    padding: 4,
  },

  // ── Ministry Header ───────────────────────────────────────────────────────────
  ministryHeader: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    alignItems: "center",
  },
  ministryTitle: {
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0.4,
    textAlign: "center",
    textTransform: "uppercase",
  },
  ministryDivider: {
    marginTop: 8,
    width: 40,
    height: 3,
    borderRadius: 2,
  },

  // ── OMEGA emergency banner ───────────────────────────────────────────────────
  // `top` is set dynamically via topInset so it never clips behind the notch.
  emergencyBanner: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: "rgba(220, 38, 38, 0.95)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 7,
    zIndex: 30,
  },
  emergencyBannerTitle: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 1.1,
    flexShrink: 0,
  },
  emergencyBannerMsg: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 11,
    flex: 1,
  },

  // ── Hero floating elements ───────────────────────────────────────────────────
  // Live progress bar — bottom edge of hero (3 px, full-width track).
  heroProgressTrack: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: "rgba(255,255,255,0.22)",
    zIndex: 20,
  },
  heroProgressFill: {
    height: 3,
    backgroundColor: "rgba(255,255,255,0.88)",
    borderTopRightRadius: 1.5,
    borderBottomRightRadius: 1.5,
  },
  // Mute/unmute toggle — top-right corner of hero.
  heroMuteBtn: {
    position: "absolute",
    right: 14,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.52)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 25,
  },
  // Floating logo bar — anchored at top, positioned by topInset at render time.
  heroTopBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: 8,
    zIndex: 10,
  },
  heroLogo: {
    height: 30,
    width: 92,
  },

  // ── Hero content (bottom gradient zone) ─────────────────────────────────────
  heroContent: {
    padding: 20,
    paddingBottom: 24,
    gap: 10,
  },
  heroBadges: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  onAirBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#7c3aed",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  onAirDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#fff",
  },
  onAirText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: 1.2,
  },
  viewerBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(0,0,0,0.48)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  viewerText: {
    fontSize: 10,
    fontWeight: "600",
    color: "rgba(255,255,255,0.88)",
  },
  categoryBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  categoryBadgeText: { fontSize: 10, fontWeight: "700", color: "#fff" },
  heroBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 24,
  },
  heroBtnText: { fontSize: 14, fontWeight: "700", color: "#fff" },
  heroBtnSecondary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 24,
    borderWidth: 1.5,
  },
  heroBtnSecondaryText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  },

  // ── Content ─────────────────────────────────────────────────────────────────
  content: { paddingTop: 24, gap: 32 },
  rowContainer: { gap: 0 },
  rowContent: { paddingHorizontal: 16 },

  // ── Skeletons ────────────────────────────────────────────────────────────────
  skeletonHeader: {
    height: 18,
    width: 120,
    borderRadius: 6,
    backgroundColor: "rgba(128,128,128,0.15)",
    marginHorizontal: 16,
    marginBottom: 12,
  },

  // ── Error ───────────────────────────────────────────────────────────────────
  errorWrap: {
    margin: 16,
    borderRadius: 12,
    padding: 24,
    borderWidth: 1,
    alignItems: "center",
    gap: 8,
  },
  errorTitle: { fontSize: 16, fontWeight: "600" },
  errorDesc: { fontSize: 13, textAlign: "center" },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  retryText: { color: "#fff", fontWeight: "600", fontSize: 14 },

  // ── Stale cache indicator ────────────────────────────────────────────────────
  staleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 2,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: "#fef3c7",
  },
  staleBannerText: {
    fontSize: 11,
    fontWeight: "500",
    color: "#92400e",
    flex: 1,
  },
  staleBannerFailed: {
    backgroundColor: "#fee2e2",
  },
  staleBannerTextFailed: {
    color: "#991b1b",
  },
  staleBannerRetry: {
    fontSize: 11,
    fontWeight: "700",
    color: "#dc2626",
    textDecorationLine: "underline",
  },

  // ── Continue Watching ────────────────────────────────────────────────────────
  cwCard: {
    borderRadius: 10,
    overflow: "hidden",
  },
  cwThumb: {
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "rgba(128,128,128,0.12)",
  },
  cwPlayOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  cwPlayBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  cwTimeChip: {
    position: "absolute",
    bottom: 6,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  cwTimeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "600",
  },
  cwProgressTrack: {
    height: 3,
    borderRadius: 2,
    overflow: "hidden",
    flexDirection: "row",
  },
  cwTitle: {
    fontSize: 12,
    fontWeight: "500",
    marginTop: 5,
    lineHeight: 16,
    paddingHorizontal: 2,
  },

  // ── Empty state ──────────────────────────────────────────────────────────────
  emptyState: {
    alignItems: "center",
    paddingVertical: 60,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
