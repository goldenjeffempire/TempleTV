import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";

interface SectionHeaderProps {
  title: string;
  /**
   * Deprecated. The "See all" CTA has been removed from section headers
   * across the broadcast-first homepage. The prop is retained so existing
   * call sites compile without modification, but it is intentionally ignored.
   */
  onSeeAll?: () => void;
  subtitle?: string;
}

export function SectionHeader({ title, subtitle }: SectionHeaderProps) {
  const c = useColors();
  return (
    <View style={styles.container}>
      <View>
        <Text style={[styles.title, { color: c.foreground }]}>{title}</Text>
        {subtitle && <Text style={[styles.subtitle, { color: c.mutedForeground }]}>{subtitle}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
