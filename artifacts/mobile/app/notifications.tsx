import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

/**
 * Notification Inbox — Temple TV Mobile
 *
 * Displays the last 50 broadcast notifications sent via the platform.
 * Users who missed a push notification can review recent announcements
 * here: live service alerts, new sermon releases, emergency broadcasts.
 *
 * Fetches from GET /api/v1/notifications/history (public endpoint — the
 * notification content itself is not user-specific). Supports pull-to-
 * refresh and infinite scroll.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { getApiBase } from "@/lib/apiBase";

interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  type: string;
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number | null;
}

interface NotificationPage {
  notifications: NotificationRecord[];
  total: number;
  page: number;
  limit: number;
}

type NotifType =
  | "live_alert"
  | "sermon_alert"
  | "emergency_alert"
  | "general"
  | string;

function typeLabel(type: NotifType): string {
  switch (type) {
    case "live_alert":       return "Live Service";
    case "sermon_alert":     return "New Sermon";
    case "emergency_alert":  return "Emergency";
    default:                 return "Announcement";
  }
}

function typeColor(type: NotifType): string {
  switch (type) {
    case "live_alert":      return "#DC2626";
    case "emergency_alert": return "#EA580C";
    case "sermon_alert":    return "#7C3AED";
    default:                return "#2563EB";
  }
}

function typeIcon(type: NotifType): React.ComponentProps<typeof Feather>["name"] {
  switch (type) {
    case "live_alert":      return "radio";
    case "emergency_alert": return "alert-triangle";
    case "sermon_alert":    return "play-circle";
    default:                return "bell";
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60)  return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)    return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7)     return `${diffD}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const PAGE_SIZE = 20;

async function fetchPage(page: number): Promise<NotificationPage> {
  const base = getApiBase();
  const url = `${base}/api/v1/notifications/history?page=${page}&limit=${PAGE_SIZE}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<NotificationPage>;
}

function NotifCard({
  item,
  colors,
}: {
  item: NotificationRecord;
  colors: ReturnType<typeof useColors>;
}) {
  const sentAt = item.sentAt ?? item.scheduledAt;
  const color  = typeColor(item.type);
  const icon   = typeIcon(item.type);
  const label  = typeLabel(item.type);

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: color + "18" }]}>
        <Feather name={icon} size={18} color={color} />
      </View>
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <View style={[styles.typeBadge, { backgroundColor: color + "18" }]}>
            <Text style={[styles.typeText, { color }]}>{label}</Text>
          </View>
          <Text style={[styles.timeText, { color: colors.mutedForeground }]}>
            {formatRelative(sentAt)}
          </Text>
        </View>
        <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={2}>
          {item.title}
        </Text>
        {!!item.body && (
          <Text
            style={[styles.cardBody2, { color: colors.mutedForeground }]}
            numberOfLines={3}
          >
            {item.body}
          </Text>
        )}
        {item.recipientCount != null && item.recipientCount > 0 && (
          <Text style={[styles.recipients, { color: colors.mutedForeground }]}>
            <Feather name="users" size={10} /> {item.recipientCount.toLocaleString()} recipients
          </Text>
        )}
      </View>
    </View>
  );
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const c      = useColors();

  const [items, setItems]         = useState<NotificationRecord[]>([]);
  const [page, setPage]           = useState(1);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const hasMore = items.length < total;

  const load = useCallback(async (pg: number, reset: boolean) => {
    try {
      const data = await fetchPage(pg);
      setItems((prev) => reset ? data.notifications : [...prev, ...data.notifications]);
      setTotal(data.total);
      setPage(pg);
      setError(null);
    } catch (err) {
      setError("Couldn't load notifications. Check your connection.");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await load(1, true);
      setLoading(false);
    })();
  }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(1, true);
    setRefreshing(false);
  }, [load]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await load(page + 1, false);
    setLoadingMore(false);
  }, [loadingMore, hasMore, load, page]);

  const renderItem = useCallback(
    ({ item }: { item: NotificationRecord }) => <NotifCard item={item} colors={c} />,
    [c],
  );

  const keyExtractor = useCallback((item: NotificationRecord) => item.id, []);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader
        title="Notifications"
        left={
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="arrow-left" size={22} color={c.foreground} />
          </Pressable>
        }
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Feather name="wifi-off" size={48} color={c.mutedForeground} />
          <Text style={[styles.errorTitle, { color: c.foreground }]}>Connection Error</Text>
          <Text style={[styles.errorDesc, { color: c.mutedForeground }]}>{error}</Text>
          <Pressable
            onPress={handleRefresh}
            style={[styles.retryBtn, { backgroundColor: c.primary }]}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="bell" size={52} color={c.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: c.foreground }]}>No Notifications</Text>
          <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
            Push notifications sent by Temple TV will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + 100 },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={c.primary}
            />
          }
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Text style={[styles.countLabel, { color: c.mutedForeground }]}>
              {total} notification{total !== 1 ? "s" : ""}
            </Text>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={c.primary} />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
    paddingBottom: 60,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { paddingTop: 8, paddingHorizontal: 16 },
  countLabel: {
    fontSize: 12,
    fontWeight: "500",
    paddingBottom: 8,
  },
  card: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardBody: { flex: 1, gap: 4 },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    justifyContent: "space-between",
  },
  typeBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  typeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  timeText: { fontSize: 11 },
  cardTitle: { fontSize: 14, fontWeight: "600", lineHeight: 20 },
  cardBody2: { fontSize: 13, lineHeight: 18 },
  recipients: { fontSize: 11, marginTop: 2 },
  errorTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  errorDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  emptyTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  retryText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  footerLoader: { paddingVertical: 16, alignItems: "center" },
});
