import React from "react";
import { StyleSheet, View, useColorScheme, type ViewStyle } from "react-native";
import { useColors } from "@/hooks/useColors";
import colors from "@/constants/colors";

interface GlassCardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  intensity?: "low" | "medium" | "high";
}

export function GlassCard({ children, style, intensity = "medium" }: GlassCardProps) {
  const c = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  const opacityMap = { low: 0.05, medium: 0.10, high: 0.18 };
  const opacity = opacityMap[intensity];

  const primaryRgb = isDark ? "155, 48, 255" : "106, 13, 173";
  const bgColor = `rgba(${primaryRgb}, ${opacity})`;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: bgColor,
          borderColor: c.border,
          borderRadius: colors.radius,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    overflow: "hidden",
  },
});
