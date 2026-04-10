import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { useColors } from "@/hooks/useColors";
import colors from "@/constants/colors";

interface GlassCardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  intensity?: "low" | "medium" | "high";
}

export function GlassCard({ children, style, intensity = "medium" }: GlassCardProps) {
  const c = useColors();
  const opacityMap = { low: 0.04, medium: 0.08, high: 0.15 };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: `rgba(106, 13, 173, ${opacityMap[intensity]})`,
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
