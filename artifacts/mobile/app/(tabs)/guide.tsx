import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { fetchBroadcastGuide, type BroadcastGuideItem } from "@/services/broadcast";

const REMINDERS_KEY = "@temple_tv/guide_reminders";

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  const mins = String(m).padStart(2, "0");
  return `${hour}:${mins} ${ampm}`;
}

function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

function ReminderButton({
  itemId,
  reminders,
  onToggle,
  c,
}: {
  itemId: string;
  reminders: Set<string>;
  onToggle: (id: string) => void;
  c: ReturnType<typeof useColors>;
}) {
  const isSet = reminders.has(itemId);
  return (
    <Pressable
      onPress={() => onToggle(itemId)}
      style={({ pressed }) => [
        styles.reminderBtn,
        {
          backgroundColor: isSet ? "rgba(245,158,11,0.12)" : c.secondary,
          borderColor: isSet ? "rgba(245,158,11,0.45)" : c.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Feather
        name={isSet ? "bell" : "bell-off"}
        size={12}
        color={isSet ? "#f59e0b" : c.mutedForeground}
      />
      <Text
        style={[
          styles.reminderText,
          { color: isSet ? "#f59e0b" : c.mutedForeground },
        ]}
      >
        {isSet ? "Reminded" : "Remind me"}
      </Text>
    </Pressable>
  );
}

function GuideItemCard({
  item,
  onPress,
  reminders,
  onToggleReminder,
  c,
}: {
  item: BroadcastGuideItem;
  onPress: (item: BroadcastGuideItem) => void;
  reminders: Set<string>;
  onToggleReminder: (id: string) => void;
  c: ReturnType<typeof useColors>;
}) {
  if (item.isCurrent) {
    return (
      <Pressable
        onPress={() => onPress(item)}
        style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] }]}
      >
        <GlassCard style={[styles.currentCard]} intensity="high">
          {!!item.thumbnailUrl && (
            <Image
              source={{ uri: item.thumbnailUrl }}
              style={styles.currentThumb}
              resizeMode="cover"
              defaultSource={PLACEHOLDER}
            />
          )}
          <LinearGradient
            colors={["transparent", "rgba(0,0,0,0.85)"]}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.currentOverlay}>
            <View style={styles.nowBadgeRow}>
              <View style={styles.nowBadge}>
                <View style={styles.nowDot} />
                <Text style={styles.nowBadgeText}>NOW ON AIR</Text>
              </View>
              <Text style={styles.currentTime}>{fmtTime(item.startMs)} – {fmtTime(item.endMs)}</Text>
            </View>
            <Text style={styles.currentTitle} numberOfLines={2}>{item.title}</Text>
            <Text style={styles.currentDuration}>{fmtDuration(item.durationSecs)}</Text>

            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.min(100, item.progressPercent)}%` as any }]} />
            </View>

            <View style={styles.currentActions}>
              <Pressable
                style={styles.tuneInBtn}
                onPress={() => onPress(item)}
              >
                <Feather name="play" size={14} color="#FFF" />
                <Text style={styles.tuneInText}>Tune In</Text>
              </Pressable>
              <View style={styles.remainingPill}>
                <Feather name="clock" size={11} color="rgba(255,255,255,0.7)" />
                <Text style={styles.remainingText}>
                  {fmtDuration(Math.max(0, item.durationSecs - item.positionSecs))} left
                </Text>
              </View>
            </View>
          </View>
        </GlassCard>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.upcomingRow, { backgroundColor: c.card, opacity: pressed ? 0.8 : 1 }]}
    >
      {!!item.thumbnailUrl ? (
        <Image
          source={{ uri: item.thumbnailUrl }}
          style={styles.upcomingThumb}
          resizeMode="cover"
          defaultSource={PLACEHOLDER}
        />
      ) : (
        <View style={[styles.upcomingThumb, { backgroundColor: c.muted, alignItems: "center", justifyContent: "center" }]}>
          <Feather name="tv" size={18} color={c.mutedForeground} />
        </View>
      )}
      <View style={styles.upcomingMeta}>
        <Text style={[styles.upcomingTime, { color: c.primary }]}>{fmtTime(item.startMs)}</Text>
        <Text style={[styles.upcomingTitle, { color: c.foreground }]} numberOfLines={2}>{item.title}</Text>
        <Text style={[styles.upcomingDuration, { color: c.mutedForeground }]}>{fmtDuration(item.durationSecs)}</Text>
        <View style={{ marginTop: 4 }}>
          <ReminderButton
            itemId={item.id}
            reminders={reminders}
            onToggle={onToggleReminder}
            c={c}
          />
        </View>
      </View>
      <Feather name="chevron-right" size={16} color={c.mutedForeground} />
    </Pressable>
  );
}

export default function GuideScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const fadeAnim = useRef(new Animated.Value(Platform.OS === "web" ? 1 : 0)).current;
  const [guide, setGuide] = useState<BroadcastGuideItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [reminders, setReminders] = useState<Set<string>>(new Set());

  const loadReminders = async () => {
    try {
      const raw = await AsyncStorage.getItem(REMINDERS_KEY);
      if (raw) setReminders(new Set(JSON.parse(raw) as string[]));
    } catch {}
  };

  const toggleReminder = useCallback(async (itemId: string) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setReminders((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);

  const loadGuide = useCallback(async () => {
    try {
      const result = await fetchBroadcastGuide();
      if (result?.items) {
        setGuide(result.items);
        setLastUpdated(new Date());
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: Platform.OS !== "web" }).start();
    loadReminders();
    loadGuide();
    const interval = setInterval(loadGuide, 60000);
    return () => clearInterval(interval);
  }, [loadGuide]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadGuide();
    setRefreshing(false);
  };

  const handleItemPress = (item: BroadcastGuideItem) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const startMs = item.isCurrent ? String(item.positionSecs * 1000) : "0";
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
  };

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const topPad = insets.top + webTopPad;
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const currentItem = guide.find((g) => g.isCurrent);
  const upcomingItems = guide.filter((g) => !g.isCurrent);
  const reminderCount = reminders.size;

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: topPad + 8, paddingBottom: 160 }}
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
          <View style={styles.header}>
            <View>
              <Text style={[styles.headerTitle, { color: c.foreground }]}>Programme Guide</Text>
              <Text style={[styles.headerDate, { color: c.mutedForeground }]}>{today}</Text>
              {reminderCount > 0 && (
                <Text style={[styles.reminderCount, { color: "#f59e0b" }]}>
                  {reminderCount} reminder{reminderCount !== 1 ? "s" : ""} set
                </Text>
              )}
            </View>
            <View style={[styles.channelBug, { backgroundColor: "rgba(106,13,173,0.15)", borderColor: c.primary + "40" }]}>
              <View style={styles.bugDot} />
              <Text style={[styles.bugText, { color: c.primary }]}>TEMPLE TV</Text>
            </View>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <View style={[styles.skeletonBlock, { backgroundColor: c.muted, height: 220, borderRadius: 16 }]} />
              {[1, 2, 3, 4].map((i) => (
                <View key={i} style={[styles.skeletonRow, { backgroundColor: c.muted }]} />
              ))}
            </View>
          ) : guide.length === 0 ? (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIcon, { backgroundColor: c.muted }]}>
                <Feather name="tv" size={32} color={c.mutedForeground} />
              </View>
              <Text style={[styles.emptyTitle, { color: c.foreground }]}>No Schedule Available</Text>
              <Text style={[styles.emptySubtitle, { color: c.mutedForeground }]}>
                Add videos to the broadcast queue in the admin panel to build your programme guide.
              </Text>
            </View>
          ) : (
            <View style={styles.content}>
              {currentItem && (
                <View style={styles.section}>
                  <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>Now</Text>
                  <GuideItemCard
                    item={currentItem}
                    onPress={handleItemPress}
                    reminders={reminders}
                    onToggleReminder={toggleReminder}
                    c={c}
                  />
                </View>
              )}

              {upcomingItems.length > 0 && (
                <View style={styles.section}>
                  <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>Coming Up</Text>
                  <View style={[styles.upcomingList, { borderColor: c.border }]}>
                    {upcomingItems.map((item, idx) => (
                      <React.Fragment key={`${item.id}-${idx}`}>
                        <GuideItemCard
                          item={item}
                          onPress={handleItemPress}
                          reminders={reminders}
                          onToggleReminder={toggleReminder}
                          c={c}
                        />
                        {idx < upcomingItems.length - 1 && (
                          <View style={[styles.divider, { backgroundColor: c.border }]} />
                        )}
                      </React.Fragment>
                    ))}
                  </View>
                </View>
              )}

              {lastUpdated && (
                <Text style={[styles.updatedText, { color: c.mutedForeground }]}>
                  Guide refreshes every minute · Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Text>
              )}
            </View>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  headerTitle: { fontSize: 24, fontWeight: "700" },
  headerDate: { fontSize: 13, marginTop: 2 },
  reminderCount: { fontSize: 12, fontWeight: "600", marginTop: 4 },
  channelBug: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 4,
  },
  bugDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: "#FF0040" },
  bugText: { fontSize: 10, fontWeight: "700", letterSpacing: 1.5 },
  content: { gap: 4 },
  section: { marginBottom: 20, paddingHorizontal: 16 },
  sectionLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 },
  currentCard: { borderRadius: 16, overflow: "hidden", minHeight: 200 },
  currentThumb: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  currentOverlay: { padding: 16, gap: 6 },
  nowBadgeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  nowBadge: { flexDirection: "row", alignItems: "center", gap: 5 },
  nowDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: "#FF0040" },
  nowBadgeText: { color: "#FF0040", fontSize: 10, fontWeight: "700", letterSpacing: 1.2 },
  currentTime: { color: "rgba(255,255,255,0.7)", fontSize: 11 },
  currentTitle: { color: "#FFF", fontSize: 18, fontWeight: "700", lineHeight: 24 },
  currentDuration: { color: "rgba(255,255,255,0.6)", fontSize: 12 },
  progressTrack: { height: 3, backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 2, overflow: "hidden", marginTop: 4 },
  progressFill: { height: "100%" as any, backgroundColor: "#6A0DAD", borderRadius: 2 },
  currentActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  tuneInBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#6A0DAD",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  tuneInText: { color: "#FFF", fontSize: 13, fontWeight: "600" },
  remainingPill: { flexDirection: "row", alignItems: "center", gap: 4 },
  remainingText: { color: "rgba(255,255,255,0.65)", fontSize: 11 },
  upcomingList: { borderRadius: 12, overflow: "hidden", borderWidth: 1 },
  upcomingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  upcomingThumb: { width: 70, height: 44, borderRadius: 6 },
  upcomingMeta: { flex: 1 },
  upcomingTime: { fontSize: 11, fontWeight: "600", marginBottom: 2 },
  upcomingTitle: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  upcomingDuration: { fontSize: 11, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 96 },
  loadingContainer: { paddingHorizontal: 16, gap: 10, marginTop: 8 },
  skeletonBlock: {},
  skeletonRow: { height: 68, borderRadius: 8 },
  emptyContainer: { alignItems: "center", paddingTop: 80, paddingHorizontal: 32, gap: 14 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptySubtitle: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  updatedText: { fontSize: 11, textAlign: "center", paddingBottom: 8, paddingHorizontal: 16 },
  reminderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  reminderText: { fontSize: 11, fontWeight: "600" },
});
