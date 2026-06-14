import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";

interface ScreenHeaderProps {
  title: string;
}

/**
 * Universal tab-screen header.
 *
 * Renders the Temple TV logo image on the left and the current screen title
 * on the right. Handles the device safe-area top inset internally so each
 * screen never needs to add its own paddingTop for the status bar.
 *
 * Usage:
 *   <ScreenHeader title="Library" />
 */
export function ScreenHeader({ title }: ScreenHeaderProps) {
  const insets = useSafeAreaInsets();
  const c = useColors();

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 6,
          backgroundColor: c.background,
        },
      ]}
      accessibilityRole="header"
    >
      <Image
        source={require("@/assets/images/temple-tv-logo-full.png")}
        style={styles.logo}
        resizeMode="contain"
        accessible
        accessibilityLabel="Temple TV"
      />
      <Text
        style={[styles.title, { color: c.foreground }]}
        numberOfLines={1}
        accessibilityRole="text"
      >
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(128,128,128,0.15)",
  },
  logo: {
    height: 38,
    width: 110,
  },
  title: {
    flex: 1,
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: -0.4,
    textAlign: "right",
  },
});
