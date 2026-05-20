import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { AppHeader } from "@/components/AppHeader";
import { getApiBase } from "@/lib/apiBase";
import { usePageSeo } from "@/hooks/usePageSeo";
import { fetchChannels, type ApiChannel } from "@/services/api";
import type { SermonCategory } from "@/types";

// ─── Content category config ──────────────────────────────────────────────────

type CategoryConfig = {
  label: string;
  value: SermonCategory;
  color: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  description: string;
};

const CONTENT_CATEGORIES: CategoryConfig[] = [
  { label: "Sermons",     value: "Sermons",     color: "#0891b2", icon: "book-open", description: "Sermons & Bible lessons" },
  { label: "Prayers",     value: "Prayers",     color: "#be185d", icon: "feather",   description: "Intercession & vigils" },
  { label: "Crusades",    value: "Crusades",    color: "#b45309", icon: "globe",     description: "Evangelism & outreaches" },
  { label: "Conferences", value: "Conferences", color: "#0e7490", icon: "users",     description: "Summits & conventions" },
  { label: "Testimonies", value: "Testimonies", color: "#047857", icon: "star",      description: "Miracles & breakthroughs" },
  { label: "Deliverance", value: "Deliverance", color: "#ea580c", icon: "shield",    description: "Freedom & breakthrough" },
];

// ─── Real-time live channel hook ──────────────────────────────────────────────
//
// Retry strategy (initial load only):
//   attempt 1 → immediate
//   attempt 2 → 1 500 ms delay
//   attempt 3 → 4 000 ms delay
//
// Background (quiet) refreshes triggered by SSE or the 30-second poll never
// count toward the retry budget and never surface errors to the UI — they
// silently merge fresh data when available.

const RETRY_DELAYS_MS = [0, 1_500, 4_000] as const;

function useChannels() {
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  // Signals component is still mounted — guards every async state setter.
  const mountedRef       = useRef(true);
  const sseRef           = useRef<EventSource | null>(null);
  // Stored so they can be cancelled on unmount.
  const sseReconnectRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Quiet background refresh (SSE / poll) ─────────────────────────────────
  const doQuietRefetch = useCallback(async () => {
    try {
      const data = await fetchChannels();
      if (!mountedRef.current) return;
      // Guard: only update state when we actually get an array back.
      if (Array.isArray(data)) setChannels(data);
    } catch {
      // Background failures are intentionally swallowed — the stale list
      // the user already sees is better than a disruptive error flash.
    }
  }, []);

  // ── Initial load with automatic retry ────────────────────────────────────
  const fetchWithRetry = useCallback(async () => {
    setLoading(true);
    setError(null);
    setIsRetrying(false);

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        // Wait between retries; store the timer so cleanup can cancel it.
        setIsRetrying(true);
        await new Promise<void>((resolve) => {
          retryTimerRef.current = setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
        });
        if (!mountedRef.current) return;
      }

      try {
        const data = await fetchChannels(); // 12 s timeout baked in
        if (!mountedRef.current) return;

        // Defensive: the server always returns a raw array, but guard anyway.
        setChannels(Array.isArray(data) ? data : []);
        setLoading(false);
        setIsRetrying(false);
        setError(null);
        return; // success — stop retrying
      } catch (err) {
        if (!mountedRef.current) return;

        const isLastAttempt = attempt === RETRY_DELAYS_MS.length - 1;
        if (!isLastAttempt) continue; // try again after delay

        // All retries exhausted — surface a helpful error.
        const raw =
          err instanceof Error ? err.message : "Network error";
        // Strip redundant "Error:" prefix that some runtimes prepend.
        setError(raw.replace(/^Error:\s*/i, ""));
        setLoading(false);
        setIsRetrying(false);
      }
    }
  }, []);

  // ── Manual retry (user pressed "Try Again") ───────────────────────────────
  const refetch = useCallback(() => {
    void fetchWithRetry();
  }, [fetchWithRetry]);

  // ── Mount effect: initial load + SSE + polling ────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    void fetchWithRetry();

    const apiBase = getApiBase();

    // SSE — only available in web environments; silently skipped on native.
    if (typeof EventSource !== "undefined" && apiBase) {
      const connect = (): void => {
        if (!mountedRef.current) return;
        const es = new EventSource(`${apiBase}/api/broadcast/events`);
        sseRef.current = es;

        const handleUpdate = () => void doQuietRefetch();
        es.addEventListener("broadcast-current-updated", handleUpdate);
        es.addEventListener("viewers-updated", handleUpdate);
        es.addEventListener("channels-updated", handleUpdate);

        es.onerror = () => {
          es.close();
          sseRef.current = null;
          // Store the timer ID so we can cancel it if the component unmounts
          // before the reconnect fires.
          sseReconnectRef.current = setTimeout(connect, 5_000);
        };
      };
      connect();
    }

    // 30-second polling fallback (both web and native).
    const interval = setInterval(() => void doQuietRefetch(), 30_000);

    return () => {
      mountedRef.current = false;

      // Tear down SSE.
      sseRef.current?.close();
      sseRef.current = null;

      // Cancel pending reconnect / retry timers.
      if (sseReconnectRef.current !== null) {
        clearTimeout(sseReconnectRef.current);
        sseReconnectRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      clearInterval(interval);
    };
  }, [fetchWithRetry, doQuietRefetch]);

  return { channels, loading, error, isRetrying, refetch };
}

// ─── Live channel card ────────────────────────────────────────────────────────

function ChannelCard({
  channel,
  onPress,
  tuning,
}: {
  channel: ApiChannel;
  onPress: () => void;
  tuning: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={tuning}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, opacity: pressed || tuning ? 0.75 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Tune in to ${channel.name}`}
    >
      <View style={[styles.colorStrip, { backgroundColor: channel.color }]} />
      <View style={styles.cardContent}>
        <View
          style={[
            styles.iconBadge,
            { backgroundColor: channel.color + "22", borderColor: channel.color + "55" },
          ]}
        >
          {tuning
            ? <ActivityIndicator size="small" color={channel.color} />
            : <Feather name="tv" size={18} color={channel.color} />
          }
        </View>
        <View style={styles.cardText}>
          <View style={styles.cardTitleRow}>
            <Text style={[styles.cardName, { color: colors.text }]} numberOfLines={1}>
              {channel.name}
            </Text>
            {channel.isRunning && !tuning && (
              <View style={styles.liveBadge}>
                <View style={styles.liveDotIndicator} />
                <Text style={styles.liveBadgeText}>LIVE</Text>
              </View>
            )}
            {tuning && (
              <Text style={[styles.tuningText, { color: colors.mutedForeground }]}>Tuning…</Text>
            )}
          </View>
          <Text style={[styles.cardDesc, { color: colors.mutedForeground }]} numberOfLines={1}>
            {channel.description || `/${channel.slug}`}
          </Text>
          {channel.viewerCount > 0 && !tuning && (
            <View style={styles.viewerRow}>
              <Feather name="users" size={11} color={colors.mutedForeground} />
              <Text style={[styles.viewerText, { color: colors.mutedForeground }]}>
                {channel.viewerCount.toLocaleString()} watching
              </Text>
            </View>
          )}
        </View>
        {tuning
          ? <ActivityIndicator size="small" color={colors.primary} />
          : <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
        }
      </View>
    </Pressable>
  );
}

// ─── Category tile ─────────────────────────────────────────────────────────────

function CategoryTile({ cat }: { cat: CategoryConfig }) {
  const colors = useColors();

  const handlePress = useCallback(() => {
    router.navigate({
      pathname: "/(tabs)/library",
      params: { category: cat.value },
    });
  }, [cat.value]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.categoryTile,
        { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.75 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Browse ${cat.label} videos`}
    >
      <View style={[styles.categoryIconWrap, { backgroundColor: cat.color + "20" }]}>
        <Feather name={cat.icon} size={22} color={cat.color} />
      </View>
      <Text style={[styles.categoryTileLabel, { color: colors.text }]} numberOfLines={1}>
        {cat.label}
      </Text>
      <Text style={[styles.categoryTileDesc, { color: colors.mutedForeground }]} numberOfLines={1}>
        {cat.description}
      </Text>
      <Feather name="chevron-right" size={14} color={colors.mutedForeground} style={{ alignSelf: "flex-end", marginTop: "auto" }} />
    </Pressable>
  );
}

// ─── Section header ────────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  live,
}: {
  icon?: React.ComponentProps<typeof Feather>["name"];
  title: string;
  live?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={styles.sectionHeaderRow}>
      {live ? (
        <View style={styles.liveIndicator}>
          <View style={styles.livePulse} />
        </View>
      ) : icon ? (
        <Feather name={icon} size={15} color={colors.primary} />
      ) : null}
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
    </View>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────────────

export default function ChannelsTab() {
  usePageSeo({
    title: "Channels · Temple TV",
    description: "Browse all live channels and content categories on Temple TV – JCTM Broadcasting Network.",
    path: "/channels",
  });

  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { channels, loading, error, isRetrying, refetch } = useChannels();
  const [tuningId, setTuningId] = useState<string | null>(null);

  const handleChannelPress = useCallback((channel: ApiChannel) => {
    if (tuningId) return;

    // If the server already told us the channel is offline (isRunning=false),
    // show the alert immediately — no network round-trip needed.
    if (!channel.isRunning) {
      Alert.alert(
        `${channel.name} is Offline`,
        "This channel is not currently broadcasting. Check back later.",
        [{ text: "OK" }],
      );
      return;
    }

    // Navigate directly to the V2 broadcast engine. V2 owns its own transport
    // and fetches real-time state from /api/broadcast-v2/state — it does not
    // use any hlsUrl passed here. Navigating immediately (instead of pre-fetching
    // /channels/{slug}/current first) eliminates a 0–12 s spinner before the
    // player appears and avoids a v1/v2 mismatch where the v1 snapshot could
    // show "offline" even while v2 has content queued.
    // V2 will display its own "tuning-in" → "off-air" states if needed.
    setTuningId(channel.id);
    // Small tick so the tuning spinner renders before the navigation fires.
    requestAnimationFrame(() => {
      router.push({
        pathname: "/player",
        params: {
          id: "live",
          title: channel.name,
          isLive: "true",
          // No hlsUrl — V2 ignores it and uses its own WS/SSE transport.
          // No youtubeId — Live Channel never opens YouTube.
        },
      });
      setTuningId(null);
    });
  }, [tuningId]);

  // ── Channels section content ───────────────────────────────────────────────

  let channelsSectionContent: React.ReactNode;

  if (loading && channels.length === 0) {
    channelsSectionContent = (
      <View style={[styles.inlineLoader, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[styles.inlineLoaderText, { color: colors.mutedForeground }]}>
          Loading channels…
        </Text>
      </View>
    );
  } else if (error) {
    channelsSectionContent = (
      <View style={[styles.errorCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name="wifi-off" size={24} color={colors.mutedForeground} />
        <Text style={[styles.errorTitle, { color: colors.text }]}>Could not load channels</Text>
        <Text style={[styles.errorDetail, { color: colors.mutedForeground }]}>
          {error}
        </Text>
        <Pressable
          onPress={refetch}
          disabled={isRetrying || loading}
          style={[
            styles.retryBtn,
            { backgroundColor: isRetrying || loading ? colors.muted : colors.primary },
          ]}
        >
          {isRetrying ? (
            <ActivityIndicator size="small" color="#fff" style={{ marginRight: 6 }} />
          ) : null}
          <Text style={styles.retryText}>
            {isRetrying ? "Retrying…" : "Try Again"}
          </Text>
        </Pressable>
        <Text style={[styles.errorHint, { color: colors.mutedForeground }]}>
          You can still browse categories below
        </Text>
      </View>
    );
  } else if (channels.length === 0) {
    channelsSectionContent = (
      <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name="tv" size={28} color={colors.mutedForeground} />
        <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>
          No live channels yet. Channels created in the admin panel will appear here.
        </Text>
      </View>
    );
  } else {
    channelsSectionContent = (
      <View style={styles.channelList}>
        {channels.map((ch, i) => (
          <React.Fragment key={ch.id}>
            {i > 0 && <View style={{ height: 10 }} />}
            <ChannelCard
              channel={ch}
              onPress={() => void handleChannelPress(ch)}
              tuning={tuningId === ch.id}
            />
          </React.Fragment>
        ))}
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <AppHeader />
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Channels</Text>
        <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
          Temple TV · JCTM Broadcasting Network
        </Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 90 }]}
        refreshControl={
          <RefreshControl
            refreshing={loading && channels.length > 0}
            onRefresh={refetch}
            tintColor={colors.primary}
          />
        }
      >
        {/* ── Live Channels ─────────────────────────────────────────────── */}
        <SectionHeader live title="Live Channels" />
        {channelsSectionContent}

        {/* ── Browse by Category — always rendered regardless of channel state */}
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <SectionHeader icon="grid" title="Browse by Category" />
        <View style={styles.categoryGrid}>
          {CONTENT_CATEGORIES.map((cat) => (
            <CategoryTile key={cat.value} cat={cat} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  headerTitle: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  headerSub: { fontSize: 13, marginTop: 2 },

  scroll: { paddingHorizontal: 16, paddingTop: 4 },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
    marginTop: 4,
  },
  sectionTitle: { fontSize: 16, fontWeight: "700", letterSpacing: -0.2 },
  liveIndicator: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  livePulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
  },

  divider: { height: StyleSheet.hairlineWidth, marginVertical: 24 },

  channelList: {},

  inlineLoader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  inlineLoaderText: { fontSize: 14 },

  errorCard: {
    alignItems: "center",
    gap: 8,
    padding: 20,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorTitle: { fontSize: 15, fontWeight: "700", textAlign: "center" },
  errorDetail: { fontSize: 12, textAlign: "center", lineHeight: 17 },
  errorHint: { fontSize: 11, textAlign: "center", marginTop: 4, fontStyle: "italic" },

  emptyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  emptyCardText: { flex: 1, fontSize: 13, lineHeight: 18 },

  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 20,
    marginTop: 4,
  },
  retryText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  card: {
    borderRadius: 14,
    overflow: "hidden",
    flexDirection: "row",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  colorStrip: { width: 4 },
  cardContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardText: { flex: 1, minWidth: 0 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardName: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ef4444",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  liveDotIndicator: {
    width: 5, height: 5, borderRadius: 2.5, backgroundColor: "#fff",
  },
  liveBadgeText: { color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  tuningText: { fontSize: 11, fontStyle: "italic" },
  cardDesc: { fontSize: 12, marginTop: 2 },
  viewerRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  viewerText: { fontSize: 11 },

  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  categoryTile: {
    width: "47.5%",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 6,
    minHeight: 110,
  },
  categoryIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  categoryTileLabel: { fontSize: 14, fontWeight: "700", letterSpacing: -0.2 },
  categoryTileDesc: { fontSize: 11, lineHeight: 15 },
});
