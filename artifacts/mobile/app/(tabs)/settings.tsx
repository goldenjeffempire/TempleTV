import React, { useEffect, useState } from "react";
import {
  Alert,
  Animated,
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
import { APP_CONFIG } from "@/constants/config";
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
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const [notifPermission, setNotifPermission] = useState<string | null>(null);
  const [notifEnabled, setNotifEnabled] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    getNotificationPermissionStatus().then((status) => {
      setNotifPermission(status);
      setNotifEnabled(status === "granted");
    });
  }, []);

  const handleNotifToggle = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!notifEnabled) {
      const granted = await requestNotificationPermissions();
      setNotifEnabled(granted);
      setNotifPermission(granted ? "granted" : "denied");
      if (!granted) {
        Alert.alert(
          "Notifications Blocked",
          "Please enable notifications for Temple TV in your device Settings to receive live service alerts.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => Linking.openSettings() },
          ],
        );
      }
    } else {
      setNotifEnabled(false);
    }
  };

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

  const loopLabels = { none: "Off", all: "Loop All", one: "Loop One" };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTopPad, paddingBottom: insets.bottom + 150 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.header, { color: c.foreground }]}>Settings</Text>

        <GlassCard style={styles.profileCard} intensity="high">
          <View style={[styles.logoCircle, { backgroundColor: c.primary }]}>
            <Feather name="tv" size={28} color="#FFF" />
          </View>
          <View style={styles.profileInfo}>
            <Text style={[styles.profileName, { color: c.foreground }]}>Temple TV</Text>
            <Text style={[styles.profileSub, { color: c.mutedForeground }]}>
              Jerusalem Christian Television Ministry
            </Text>
          </View>
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
                right={<ToggleSwitch value={notifEnabled} onToggle={handleNotifToggle} />}
              />
              <Divider />
              <Row
                icon="calendar"
                label="New Sermon Notifications"
                description="Alerts when new content is published"
                right={<ToggleSwitch value={notifEnabled} onToggle={handleNotifToggle} />}
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
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>ABOUT</Text>
        <GlassCard style={styles.group}>
          <Row icon="info" label="App Name" value="Temple TV" />
          <Divider />
          <Row icon="globe" label="Channel" value="@templetvjctm" />
          <Divider />
          <Row icon="code" label="Version" value="1.0.0" />
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
  logoCircle: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
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
