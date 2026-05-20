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
      {/* Premium streaming-platform row label: a thin colored accent
          stripe to the left of the title. The stripe uses the brand
          primary so each section reads as part of a single channel
          rail (Disney+ / HBO / Apple TV+ row-rail spec). The title
          sits at 20 px Bold for hierarchy; the optional subtitle uses
          the muted-foreground tone for secondary metadata. */}
      <View style={[styles.accent, { backgroundColor: c.primary }]} />
      <View style={styles.text}>
        <Text style={[styles.title, { color: c.foreground }]}>{title}</Text>
        {subtitle && (
          <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
            {subtitle}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 10,
  },
  accent: {
    width: 4,
    height: 22,
    borderRadius: 2,
  },
  text: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    letterSpacing: 0.2,
  },
});
