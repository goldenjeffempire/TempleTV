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
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
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

// ─── Hero Section ─────────────────────────────────────────────────────────────
// Fully immersive: the hero begins at y=0 (behind the system status bar).
// topInset is the safe-area top inset used to:
//  • Extend the hero height so it fills the notch/status-bar area.
//  • Position the floating logo overlay below the notch.
//  • Position the emergency banner below the notch.
// The content below the hero (category rows) scrolls normally — only the hero
// extends under the status bar.

interface HeroSectionProps {
  fallbackSermon: Sermon | null;
  topInset: number;
}

const HeroSection = React.memo(function HeroSection({ fallbackSermon, topInset }: HeroSectionProps) {
  const c = useColors();
  const { width } = useWindowDimensions();
  // True 16:9 video area + status-bar region above it = total hero height.
  // This lets the video fill the space that was previously occupied by the
  // redundant app header, maximising visible video area.
  const videoHeight = Math.round(width * 0.5625);
  const totalHeroHeight = videoHeight + topInset;
  const apiBase = getApiBase() ?? "";

  const { isBroadcastMode } = usePlayer();

  // Unified media state — drives badge, CTA, and status indicators.
  const {
    mediaState,
    isWatchLiveCTAVisible,
    isReconnecting,
    isFatal,
  } = useMediaPlayerState();

  // V2 FSM singleton — attaches a React listener to the already-running session.
  // No extra WS connection. Replaces v1-WS (useBroadcastSync) which caused hero
  // flicker on every reconnect even when V2 was playing normally.
  const { snapshot: v2Snapshot, forceRebind } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });
  const v2Server = v2Snapshot.lastServerSnapshot;

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

  // Live viewer count + OMEGA emergency signal from the v1 broadcast sync heartbeat.
  // V2Snapshot (player-core) does not carry viewer counts or OMEGA signals — those
  // are pushed by the v1 WS gateway and surfaced via useBroadcastSync.
  // Must be declared BEFORE the emergency-pulse useEffect so `emergencyBroadcast`
  // is not in the Temporal Dead Zone when React evaluates the dependency array.
  const { viewerCount, emergencyBroadcast, emergencyMessage } = useBroadcastSync();

  // Animated pulse for the OMEGA emergency banner — draws urgent attention.
  const emergencyPulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!emergencyBroadcast) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(emergencyPulseAnim, { toValue: 0.6, duration: 400, useNativeDriver: true }),
        Animated.timing(emergencyPulseAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [emergencyBroadcast, emergencyPulseAnim]);

  // STRICT POLICY: YouTube items are never promoted to the hero.
  // Only uploaded/local platform broadcasts get the hero treatment.
  const hasUploadedBroadcast = !!(
    v2Server?.current &&
    v2Server.current.source?.kind !== "youtube"
  );
  const hasActiveBroadcast = hasUploadedBroadcast;

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
      {/* Base layer — thumbnail when available */}
      {thumbUrl && (
        <Image
          source={{ uri: thumbUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      )}

      {/* V2 broadcast video — ALWAYS mounted (muted, minimal) to keep the singleton
          FSM session warm. pointerEvents="none" lets hero touch events reach the Pressable.
          suppressEventsOverride=isBroadcastMode: when the player screen is open, the full-
          screen player instance is the sole FSM driver — suppress watchdogs/events from this
          muted hero so it can't fire spurious buffer-error/stall that interrupt the player. */}
      <View style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
        <V2PlayerContainer
          baseUrl={`${apiBase}/api/broadcast-v2`}
          muted
          minimal
          suppressEventsOverride={isBroadcastMode}
        />
      </View>

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
          resizeMode="contain"
          accessible
          accessibilityLabel="Temple TV"
        />
      </View>

      {/* ── OMEGA emergency broadcast banner ────────────────────────────────────
          Rendered above all other hero layers (zIndex 30) when the server fires
          an EMERGENCY_BROADCAST signal via the v1 WS gateway. Cleared on the
          next PROGRAM_CHANGED event. Positioned below the notch so it never
          clips behind the status bar. pointerEvents="none" — taps still reach
          the underlying Pressable so the viewer can navigate to the player. */}
      {emergencyBroadcast && (
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

  const { sermons, byCategory, loading, error, refetch, isStale, refreshFailed } = useVideos();

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
        {/* Immersive hero — occupies (statusBarHeight + 16:9 video) pixels */}
        <HeroSection fallbackSermon={fallbackSermon} topInset={insets.top} />

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

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
