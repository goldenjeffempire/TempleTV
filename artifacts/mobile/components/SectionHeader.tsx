import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";

interface SectionHeaderProps {
  title: string;
  onSeeAll?: () => void;
  subtitle?: string;
}

export function SectionHeader({ title, onSeeAll, subtitle }: SectionHeaderProps) {
  const c = useColors();
  return (
    <View style={styles.container}>
      <View>
        <Text style={[styles.title, { color: c.foreground }]}>{title}</Text>
        {subtitle && <Text style={[styles.subtitle, { color: c.mutedForeground }]}>{subtitle}</Text>}
      </View>
      {onSeeAll && (
        <Pressable onPress={onSeeAll} hitSlop={12}>
          <Text style={[styles.seeAll, { color: c.primary }]}>See all</Text>
        </Pressable>
      )}
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
  seeAll: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
