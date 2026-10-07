import React, { useEffect, useState } from "react";
import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { safeNavPush } from "@/lib/safeNavPush";
import { liveNotificationBus } from "@/services/liveNotificationBus";

const DISPLAY_MS = 6000;

/** Root-level prompt for live pushes received while the app is foregrounded. */
export function LiveNotificationBanner() {
  const [visible, setVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const colors = useColors();

  useEffect(() => liveNotificationBus.subscribe(() => setVisible(true)), []);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => setVisible(false);
  const joinLive = () => {
    safeNavPush(
      "/player",
      { isLive: "true", title: "Live Broadcast", preacher: "JCTM Ministries" },
      "foreground-live-banner",
    );
    dismiss();
  };

  return (
    <View pointerEvents="box-none" style={[styles.host, { top: insets.top + 8 }]}>
      <Pressable
        onPress={joinLive}
        accessibilityRole="button"
        accessibilityLabel="Live broadcast available. Tap to watch now."
        testID="foreground-live-notification-banner"
        style={[styles.banner, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={[styles.icon, { backgroundColor: colors.primary }]}>
          <Feather name="radio" size={16} color={colors.primaryForeground} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.foreground }]}>Live Broadcast</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Tap to join now</Text>
        </View>
        <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: "absolute", left: 16, right: 16, zIndex: 1000 },
  banner: {
    minHeight: 64,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "black",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, marginHorizontal: 12 },
  title: { fontSize: 15, fontWeight: "600" },
  subtitle: { fontSize: 13, marginTop: 2 },
});