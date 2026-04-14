import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Animated,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { usePlayer } from "@/context/PlayerContext";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { useFavorites } from "@/hooks/useFavorites";
import { useNotificationPreferences } from "@/hooks/useNotificationPreferences";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import { APP_CONFIG } from "@/constants/config";
import { fetchPlatformStatus, type PlatformStatus } from "@/services/platform";
import {
  requestNotificationPermissions,
  getNotificationPermissionStatus,
} from "@/services/notifications";

function ToggleSwitch({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onToggle();
      }}
      style={[styles.switch, { backgroundColor: value ? c.primary : c.muted }]}
    >
      <Animated.View style={[styles.thumb, { transform: [{ translateX: value ? 20 : 0 }] }]} />
    </Pressable>
  );
}

interface RowProps {
  icon: string;
  label: string;
  description?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  danger?: boolean;
  value?: string;
}

function Row({ icon, label, description, onPress, right, danger, value }: RowProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [{ opacity: pressed && onPress ? 0.7 : 1 }]}
    >
      <View style={styles.row}>
        <View style={[styles.iconWrap, { backgroundColor: danger ? "rgba(255,59,59,0.12)" : c.secondary }]}>
          <Feather name={icon as any} size={18} color={danger ? "#FF3B3B" : c.primary} />
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowLabel, { color: danger ? "#FF3B3B" : c.foreground }]}>{label}</Text>
          {description && <Text style={[styles.rowDesc, { color: c.mutedForeground }]}>{description}</Text>}
        </View>
        {right ? right : value ? (
          <Text style={[styles.rowValue, { color: c.mutedForeground }]}>{value}</Text>
        ) : onPress ? (
          <Feather name="chevron-right" size={16} color={c.mutedForeground} />
        ) : null}
      </View>
    </Pressable>
  );
}

function Divider() {
  const c = useColors();
  return <View style={[styles.divider, { backgroundColor: c.border }]} />;
}

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isRadioMode, dataSaver, shuffleMode, loopMode, toggleRadioMode, toggleDataSaver, toggleShuffle, cycleLoopMode, stopPlayback } = usePlayer();
  const { clearHistory, history } = useWatchHistory();
  const { favorites } = useFavorites();
  const { sermons, refresh, clearCache, cacheAgeMinutes, loading: cacheLoading } = useYouTubeChannel();
  const { prefs: notifPrefs, save: saveNotifPrefs, syncWithPermissionStatus } = useNotificationPreferences();
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const [notifPermission, setNotifPermission] = useState<string | null>(null);
  const [cacheRefreshing, setCacheRefreshing] = useState(false);
  const [platformStatus, setPlatformStatus] = useState<PlatformStatus | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;
    getNotificationPermissionStatus().then((status) => {
      setNotifPermission(status ?? null);
      if (status === "granted") {
        syncWithPermissionStatus(true);
      }
    });
  }, [syncWithPermissionStatus]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const result = await fetchPlatformStatus();
      if (mounted) setPlatformStatus(result);
    };
    load();
    const interval = setInterval(load, 60000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const requestAndToggle = useCallback(
    async (key: "liveAlerts" | "newSermonAlerts", currentValue: boolean) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (!currentValue) {
        const granted = await requestNotificationPermissions();
        setNotifPermission(granted ? "granted" : "denied");
        if (granted) {
          await saveNotifPrefs({ [key]: true });
        } else {
          Alert.alert(
            "Notifications Blocked",
            "Please enable notifications for Temple TV in your device Settings to receive alerts.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Settings", onPress: () => Linking.openSettings() },
            ],
          );
        }
      } else {
        await saveNotifPrefs({ [key]: false });
      }
    },
    [saveNotifPrefs],
  );

  const confirmClearHistory = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (Platform.OS === "web") {
      if (window.confirm("Clear all watch history? This cannot be undone.")) {
        clearHistory();
      }
    } else {
      Alert.alert(
        "Clear Watch History",
        "This will remove all your watched sermon history. This action cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Clear", style: "destructive", onPress: clearHistory },
        ],
      );
    }
  };

  const refreshSermonCache = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCacheRefreshing(true);
    await refresh();
    setCacheRefreshing(false);
  };

  const confirmClearSermonCache = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const clear = async () => {
      await clearCache();
    };
    if (Platform.OS === "web") {
      if (window.confirm("Clear offline sermon metadata cache?")) clear();
    } else {
      Alert.alert(
        "Clear Sermon Cache",
        "This removes locally cached sermon metadata. The app will fetch fresh sermon details the next time it is online.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Clear", style: "destructive", onPress: clear },
        ],
      );
    }
  };

  const loopLabels = { none: "Off", all: "Loop All", one: "Loop One" };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTopPad, paddingBottom: insets.bottom + 150 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.header, { color: c.foreground }]}>Settings</Text>

        <GlassCard style={styles.profileCard} intensity="high">
          <Image
            source={require("@/assets/images/logo.png")}
            style={styles.logoImage}
            resizeMode="contain"
          />
          <View style={styles.profileInfo}>
            <Text style={[styles.profileName, { color: c.foreground }]}>Temple TV</Text>
            <Text style={[styles.profileSub, { color: c.mutedForeground }]}>
              Jesus Christ Temple Ministry
            </Text>
          </View>
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>PLATFORM STATUS</Text>
        <GlassCard style={styles.group}>
          <Row
            icon={platformStatus?.overallStatus === "critical" ? "alert-triangle" : platformStatus?.overallStatus === "degraded" ? "alert-circle" : "shield"}
            label="Broadcast Platform"
            description={
              platformStatus
                ? platformStatus.overallStatus === "ok"
                  ? "All core systems are online"
                  : "Some services need attention"
                : "Status unavailable while offline"
            }
            value={platformStatus ? platformStatus.overallStatus.toUpperCase() : "Offline"}
          />
          <Divider />
          <Row
            icon="tv"
            label="Programme Queue"
            description="Active 24/7 broadcast items"
            value={`${platformStatus?.broadcast?.activeQueueItems ?? 0} active`}
          />
          <Divider />
          <Row
            icon="database"
            label="Sermon Catalog"
            description={`${platformStatus?.database?.counts?.activeScheduleEntries ?? 0} scheduled slots`}
            value={`${platformStatus?.database?.counts?.videos ?? sermons.length} videos`}
          />
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>PLAYBACK</Text>
        <GlassCard style={styles.group}>
          <Row
            icon="radio"
            label="Radio Mode"
            description="Background audio — works with screen off"
            right={<ToggleSwitch value={isRadioMode} onToggle={toggleRadioMode} />}
          />
          <Divider />
          <Row
            icon="wifi-off"
            label="Data Saver"
            description="Lower quality stream — ideal for slow networks"
            right={<ToggleSwitch value={dataSaver} onToggle={toggleDataSaver} />}
          />
          <Divider />
          <Row
            icon="shuffle"
            label="Shuffle Mode"
            description="Play sermons in random order"
            right={<ToggleSwitch value={shuffleMode} onToggle={toggleShuffle} />}
          />
          <Divider />
          <Row
            icon="repeat"
            label="Loop Mode"
            description="Control repeat behaviour"
            value={loopLabels[loopMode]}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); cycleLoopMode(); }}
          />
        </GlassCard>

        {Platform.OS !== "web" && (
          <>
            <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>NOTIFICATIONS</Text>
            <GlassCard style={styles.group}>
              <Row
                icon="bell"
                label="Live Service Alerts"
                description={
                  notifPermission === "denied"
                    ? "Blocked — tap to open Settings"
                    : "Get notified when Temple TV goes live"
                }
                right={
                  <ToggleSwitch
                    value={notifPrefs.liveAlerts}
                    onToggle={() => requestAndToggle("liveAlerts", notifPrefs.liveAlerts)}
                  />
                }
              />
              <Divider />
              <Row
                icon="calendar"
                label="New Sermon Alerts"
                description={
                  notifPermission === "denied"
                    ? "Blocked — tap to open Settings"
                    : "Alerts when new content is published"
                }
                right={
                  <ToggleSwitch
                    value={notifPrefs.newSermonAlerts}
                    onToggle={() => requestAndToggle("newSermonAlerts", notifPrefs.newSermonAlerts)}
                  />
                }
              />
            </GlassCard>
          </>
        )}

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>YOUR CONTENT</Text>
        <GlassCard style={styles.group}>
          <Row
            icon="heart"
            label="Saved Sermons"
            value={`${favorites.length} saved`}
          />
          <Divider />
          <Row
            icon="clock"
            label="Watch History"
            value={`${history.length} sermons`}
          />
          <Divider />
          <Row
            icon="trash-2"
            label="Clear Watch History"
            description={history.length === 0 ? "No history to clear" : `Remove ${history.length} entries`}
            onPress={history.length > 0 ? confirmClearHistory : undefined}
            danger={history.length > 0}
          />
          <Divider />
          <Row
            icon="download-cloud"
            label="Offline Sermon Metadata"
            description="Cached titles, categories and thumbnails for offline browsing"
            value={`${sermons.length} cached${cacheAgeMinutes === null ? "" : ` · ${cacheAgeMinutes}m old`}`}
          />
          <Divider />
          <Row
            icon="refresh-cw"
            label="Refresh Sermon Cache"
            description={cacheRefreshing || cacheLoading ? "Updating cached metadata..." : "Preload the latest sermon list"}
            onPress={cacheRefreshing ? undefined : refreshSermonCache}
          />
          <Divider />
          <Row
            icon="trash"
            label="Clear Sermon Cache"
            description="Remove offline metadata cache"
            onPress={confirmClearSermonCache}
          />
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>TEMPLE TV CHANNEL</Text>
        <GlassCard style={styles.group}>
          <Row
            icon="youtube"
            label="Watch on YouTube"
            description={APP_CONFIG.channelUrl}
            onPress={() => Linking.openURL(APP_CONFIG.channelUrl)}
          />
          <Divider />
          <Row
            icon="radio"
            label="Join Live Stream"
            description="Watch when Temple TV is broadcasting"
            onPress={() => Linking.openURL(APP_CONFIG.channelLiveUrl)}
          />
          <Divider />
          <Row
            icon="share-2"
            label="Share This App"
            description="Invite others to watch Temple TV"
            onPress={async () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              const { Share } = await import("react-native");
              Share.share({
                message: "Watch sermons & live worship on Temple TV JCTM. Download the app: https://templetv.jctm",
                title: "Temple TV JCTM",
              });
            }}
          />
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>ABOUT</Text>
        <GlassCard style={styles.group}>
          <Row icon="info" label="App Name" value="Temple TV" />
          <Divider />
          <Row icon="globe" label="Channel" value="@templetvjctm" />
          <Divider />
          <Row
            icon="external-link"
            label="Visit Our Website"
            description="jctm.org.ng"
            onPress={() => Linking.openURL("https://jctm.org.ng")}
          />
          <Divider />
          <Row icon="code" label="Version" value="1.0.0 (1)" />
          <Divider />
          <Row
            icon="mail"
            label="Contact & Support"
            description="Reach out for help or feedback"
            onPress={() => Linking.openURL("mailto:support@templetv.jctm")}
          />
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>PLAYBACK CONTROL</Text>
        <GlassCard style={styles.group}>
          <Row
            icon="stop-circle"
            label="Stop Current Playback"
            description="Stop the active radio/stream"
            onPress={stopPlayback}
            danger
          />
        </GlassCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { fontSize: 28, fontFamily: "Inter_700Bold", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    padding: 16,
    gap: 14,
    marginBottom: 20,
  },
  logoImage: { width: 80, height: 56 },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 17, fontFamily: "Inter_700Bold" },
  profileSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 3, lineHeight: 16 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
    paddingHorizontal: 16,
    marginBottom: 8,
    marginTop: 4,
  },
  group: { marginHorizontal: 16, marginBottom: 16, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 14, gap: 12 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium" },
  rowDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2, lineHeight: 16 },
  rowValue: { fontSize: 13, fontFamily: "Inter_400Regular" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 62 },
  switch: { width: 48, height: 28, borderRadius: 14, padding: 4 },
  thumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#FFF" },
});
