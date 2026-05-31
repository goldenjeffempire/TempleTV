/**
 * Home / Watch Screen — Temple TV Mobile
 *
 * Production-grade home screen. All content is API-driven:
 *  • Live broadcast state via useBroadcastSync (WS + SSE)
 *  • Video catalog via useVideos (GET /api/videos, AsyncStorage cache)
 *
 * Layout:
 *  1. Live broadcast hero (when broadcast is active) or latest-sermon hero
 *  2. Category rows (Deliverance, Sermons, Prayers, Crusades, Conferences, Testimonies)
 *  3. Full catalog row at the bottom
 *
 * Zero mock/stub data. Zero YouTube RSS calls.
 */

import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useCallback, useMemo, useState } from "react";
import {
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
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { AppHeader } from "@/components/AppHeader";
import { LiveBadge } from "@/components/LiveBadge";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useBroadcastSync } from "@/hooks/useBroadcastSync";
import { useVideos } from "@/hooks/useVideos";
import { VideoCard } from "@/components/VideoCard";
import { SectionHeader } from "@/components/SectionHeader";
import { SkeletonVerticalCard } from "@/components/SkeletonCard";
import { V2PlayerContainer } from "@/components/V2PlayerContainer";
import { getApiBase } from "@/lib/apiBase";
import type { Sermon, SermonCategory } from "@/types";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

const CATEGORY_ROWS: SermonCategory[] = [
  "Deliverance",
  "Sermons",
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
      hlsUrl: sermon.hlsMasterUrl ?? sermon.localVideoUrl ?? "",
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
) {
  router.push({
    pathname: "/player",
    params: {
      id: "live",
      title,
      hlsUrl,
      youtubeId: youtubeId ?? "",
      isLive: "true",
      startPositionSecs: String(Math.max(0, Math.round(positionSecs))),
    },
  });
}

// ─── Hero Section ─────────────────────────────────────────────────────────────

function buildThumbnailUrl(item: {
  thumbnailUrl?: string | null;
  source?: { kind: string; url: string };
  youtubeId?: string | null;
}): string | null {
  if (item.thumbnailUrl) return item.thumbnailUrl;
  if (item.source?.kind === "youtube") {
    return `https://img.youtube.com/vi/${item.source.url}/maxresdefault.jpg`;
  }
  return null;
}

interface HeroSectionProps {
  syncState: ReturnType<typeof useBroadcastSync>;
  fallbackSermon: Sermon | null;
}

const HeroSection = React.memo(function HeroSection({ syncState, fallbackSermon }: HeroSectionProps) {
  const c = useColors();
  const { width } = useWindowDimensions();
  const heroHeight = Math.round(width * 0.58);

  // Use the properly-typed currentItem from BroadcastSyncState
  const currentItem = syncState.currentItem;
  const isLiveOverride = !!syncState.liveOverride;
  const positionSecs = syncState.positionSecs ?? 0;
  const emergencyBroadcast = syncState.emergencyBroadcast;

  // STRICT POLICY: the homepage hero only ever represents an uploaded /
  // local platform broadcast. YouTube items — including YouTube live
  // overrides — are NEVER promoted to the hero (no preview, no ON-AIR
  // badge, no "live" hero state, no YouTube imagery). They remain
  // accessible from the Library and from the full player page where the
  // YouTube iframe path can render them correctly.
  const hasUploadedBroadcast = !!(
    currentItem && (currentItem.hlsMasterUrl || currentItem.localVideoUrl)
  );
  // The single source of truth for every hero broadcast affordance.
  const hasActiveBroadcast = hasUploadedBroadcast;

  // Hero "live" state is reserved for genuine uploaded broadcasts.
  // A YouTube live override does NOT colour the hero red anymore — that
  // policy lives on the dedicated YouTube live surfaces (TV LiveHero,
  // full-screen player), not on the mobile homepage hero.
  const isLive = hasUploadedBroadcast && (isLiveOverride || !!emergencyBroadcast);
  const hlsUrl =
    hasUploadedBroadcast
      ? (currentItem?.hlsMasterUrl ?? currentItem?.localVideoUrl ?? null)
      : null;
  // Only the fallback sermon title is shown in the hero —
  // titles of actively-broadcasting videos are intentionally not displayed.
  const fallbackTitle = fallbackSermon?.title ?? "Temple TV";
  // Thumbnail behind the hero never sources from YouTube imagery — when
  // the broadcast is YouTube (or off-air) we use the latest-sermon poster.
  const thumbUrl =
    hasUploadedBroadcast && currentItem?.thumbnailUrl
      ? currentItem.thumbnailUrl
      : fallbackSermon?.thumbnailUrl ?? null;

  const handleTuneIn = useCallback(() => {
    if (hasActiveBroadcast && hlsUrl) {
      navigateToLive(hlsUrl, "Temple TV", positionSecs);
    } else if (fallbackSermon) {
      navigateToSermon(fallbackSermon);
    }
  }, [hasActiveBroadcast, hlsUrl, positionSecs, fallbackSermon]);

  return (
    <Pressable
      onPress={handleTuneIn}
      style={{ width, height: heroHeight }}
      accessibilityRole="button"
      accessibilityLabel={hasActiveBroadcast ? "Watch Now — live broadcast" : "Watch latest sermon"}
    >
      {/* Background — always show the thumbnail image as the base layer so
          the hero is never a bare black box.  When a live uploaded broadcast
          is active the V2 player renders ON TOP of the thumbnail; once its
          HLS handshake completes the video covers the poster naturally.
          This prevents the "ON AIR badge + pure black rectangle" state that
          occurs while the player is in BOOTSTRAP / SYNCING or when the
          production V2 orchestrator has no resolved source yet. */}
      {thumbUrl ? (
        <Image
          source={{ uri: thumbUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: "#1a0030" }]} />
      )}
      {/* V2 player overlay — mounted on top of the poster only when an
          uploaded broadcast is active.  `minimal` suppresses the player's
          own overlays so the hero controls (badges, CTA) stay visible. */}
      {hasUploadedBroadcast && (
        <View style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
          <V2PlayerContainer
            baseUrl={`${getApiBase() ?? ""}/api/broadcast-v2`}
            muted
            minimal
          />
        </View>
      )}

      {/* Gradient overlay */}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.85)"]}
        style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
      >
        <View style={styles.heroContent}>
          {/* Badges */}
          <View style={styles.heroBadges}>
            {isLive && <LiveBadge />}
            {hasActiveBroadcast && !isLive && (
              <View style={styles.onAirBadge}>
                <View style={styles.onAirDot} />
                <Text style={styles.onAirText}>ON AIR</Text>
              </View>
            )}
            {!hasActiveBroadcast && fallbackSermon?.category && (
              <View style={[styles.categoryBadge, { backgroundColor: c.primary + "cc" }]}>
                <Text style={styles.categoryBadgeText}>{fallbackSermon.category}</Text>
              </View>
            )}
          </View>

          {/* Title — only shown for the fallback sermon, never for broadcasts */}
          {!hasActiveBroadcast && (
            <Text style={styles.heroTitle} numberOfLines={2}>
              {fallbackTitle}
            </Text>
          )}

          {/* CTA Button */}
          <Pressable
            onPress={handleTuneIn}
            style={[
              styles.heroBtn,
              { backgroundColor: isLive ? "#ef4444" : c.primary },
            ]}
          >
            <Feather name="play" size={14} color="#fff" />
            <Text style={styles.heroBtnText}>Watch Now</Text>
          </Pressable>
        </View>
      </LinearGradient>
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
      <SectionHeader
        title={category}
        onSeeAll={() => router.push({ pathname: "/(tabs)/library" })}
      />
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

export default function WatchScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isOnline: networkConnected } = useNetworkStatus();

  const syncState = useBroadcastSync();
  const { sermons, byCategory, loading, error, refetch, isStale, refreshFailed } = useVideos();

  // Latest sermon as hero fallback (newest first).
  //
  // STRICT POLICY: the hero must never display YouTube-sourced imagery —
  // including in the off-air / fallback state. We therefore prefer a
  // local-platform sermon with a thumbnail; only if no local item is
  // available do we drop the thumbnail entirely (the hero shows the
  // branded gradient instead) rather than fall back to a YouTube poster.
  const fallbackSermon = useMemo<Sermon | null>(() => {
    const localOnly = sermons.filter((s) => s.videoSource === "local");
    return (
      localOnly.find((s) => !!s.thumbnailUrl) ??
      localOnly[0] ??
      null
    );
  }, [sermons]);

  // Non-empty category rows
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
      <AppHeader
        right={
          <Pressable
            onPress={() => router.push("/search")}
            accessibilityLabel="Search"
            accessibilityRole="button"
            hitSlop={8}
          >
            <Feather name="search" size={22} color={c.foreground} />
          </Pressable>
        }
      />

      {/* Stale cache indicator — three states:
          1. isStale + refreshing:  "Showing cached content — refreshing…"
          2. isStale + failed:      "Couldn't refresh — showing saved content" + retry
          3. network offline:       hidden (NetworkBanner already covers this)
          Dismissed automatically when fresh data arrives (isStale → false). */}
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
        {/* Hero */}
        <HeroSection syncState={syncState} fallbackSermon={fallbackSermon} />

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
  // Hero
  heroContent: {
    padding: 20,
    gap: 10,
  },
  heroBadges: { flexDirection: "row", gap: 8, alignItems: "center" },
  onAirBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#7c3aed",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  onAirDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  onAirText: { fontSize: 10, fontWeight: "700", color: "#fff", letterSpacing: 0.5 },
  categoryBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  categoryBadgeText: { fontSize: 10, fontWeight: "700", color: "#fff" },
  heroTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#fff",
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  heroBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 24,
  },
  heroBtnText: { fontSize: 14, fontWeight: "700", color: "#fff" },

  // Content
  content: { paddingTop: 24, gap: 32 },
  rowContainer: { gap: 0 },
  rowContent: { paddingHorizontal: 16 },

  // Skeleton
  skeletonHeader: {
    height: 18,
    width: 120,
    borderRadius: 6,
    backgroundColor: "rgba(128,128,128,0.15)",
    marginHorizontal: 16,
    marginBottom: 12,
  },

  // Error
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

  // Stale cache indicator
  staleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginHorizontal: 16,
    marginTop: 6,
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

  // Empty
  emptyState: {
    alignItems: "center",
    paddingVertical: 60,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
