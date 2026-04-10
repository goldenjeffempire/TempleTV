import React from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { usePlayer } from "@/context/PlayerContext";
import { JCTM_CHANNEL_URL } from "@/services/youtube";
import colors from "@/constants/colors";

interface SettingRowProps {
  icon: string;
  label: string;
  description?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
  danger?: boolean;
}

function SettingRow({ icon, label, description, onPress, rightElement, danger }: SettingRowProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [{ opacity: pressed && onPress ? 0.7 : 1 }]}
    >
      <View style={styles.settingRow}>
        <View style={[styles.iconWrap, { backgroundColor: danger ? "rgba(255,59,59,0.15)" : c.secondary }]}>
          <Feather name={icon as any} size={18} color={danger ? "#FF3B3B" : c.primary} />
        </View>
        <View style={styles.settingText}>
          <Text style={[styles.settingLabel, { color: danger ? "#FF3B3B" : c.foreground }]}>{label}</Text>
          {description && (
            <Text style={[styles.settingDesc, { color: c.mutedForeground }]}>{description}</Text>
          )}
        </View>
        {rightElement ?? (onPress ? <Feather name="chevron-right" size={18} color={c.mutedForeground} /> : null)}
      </View>
    </Pressable>
  );
}

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
      <View style={[styles.thumb, { transform: [{ translateX: value ? 20 : 0 }] }]} />
    </Pressable>
  );
}

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isRadioMode, dataSaver, toggleRadioMode, toggleDataSaver, stopPlayback } = usePlayer();
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  const openChannel = () => {
    Linking.openURL(JCTM_CHANNEL_URL);
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTopPad, paddingBottom: insets.bottom + 140 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.header, { color: c.foreground }]}>Settings</Text>

        <View style={styles.profileCard}>
          <GlassCard style={styles.profileInner} intensity="high">
            <View style={[styles.logoCircle, { backgroundColor: c.primary }]}>
              <Feather name="tv" size={32} color="#FFF" />
            </View>
            <View>
              <Text style={[styles.profileName, { color: c.foreground }]}>Temple TV</Text>
              <Text style={[styles.profileSub, { color: c.mutedForeground }]}>JCTM Broadcasting Network</Text>
            </View>
          </GlassCard>
        </View>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>PLAYBACK</Text>
        <GlassCard style={styles.group}>
          <SettingRow
            icon="radio"
            label="Radio Mode"
            description="Audio-only background playback"
            rightElement={<ToggleSwitch value={isRadioMode} onToggle={toggleRadioMode} />}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <SettingRow
            icon="wifi-off"
            label="Data Saver"
            description="Lower quality to save data"
            rightElement={<ToggleSwitch value={dataSaver} onToggle={toggleDataSaver} />}
          />
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>TEMPLE TV CHANNEL</Text>
        <GlassCard style={styles.group}>
          <SettingRow
            icon="youtube"
            label="Visit YouTube Channel"
            description="youtube.com/@templetvjctm"
            onPress={openChannel}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <SettingRow
            icon="share-2"
            label="Share Temple TV"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            }}
          />
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>ABOUT</Text>
        <GlassCard style={styles.group}>
          <SettingRow
            icon="info"
            label="About Temple TV"
            description="JCTM – Jerusalem Christian Television Ministry"
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <SettingRow
            icon="globe"
            label="Version"
            description="1.0.0"
          />
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>PLAYBACK CONTROL</Text>
        <GlassCard style={styles.group}>
          <SettingRow
            icon="stop-circle"
            label="Stop Playback"
            description="Stop current stream"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              stopPlayback();
            }}
            danger
          />
        </GlassCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
  },
  profileCard: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  profileInner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 14,
  },
  logoCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  profileName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  profileSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
    paddingHorizontal: 16,
    marginBottom: 8,
    marginTop: 4,
  },
  group: {
    marginHorizontal: 16,
    marginBottom: 16,
    overflow: "hidden",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 14,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  settingText: {
    flex: 1,
  },
  settingLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  settingDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 64,
  },
  switch: {
    width: 48,
    height: 28,
    borderRadius: 14,
    padding: 4,
  },
  thumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#FFF",
  },
});
