import React from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { CATEGORIES } from "@/data/sermons";
import type { SermonCategory } from "@/types";

interface CategoryPillsProps {
  selected: SermonCategory;
  onSelect: (cat: SermonCategory) => void;
}

export function CategoryPills({ selected, onSelect }: CategoryPillsProps) {
  const c = useColors();

  return (
    <FlatList
      horizontal
      data={CATEGORIES}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.list}
      keyExtractor={(item) => item}
      renderItem={({ item }) => {
        const isActive = item === selected;
        return (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onSelect(item as SermonCategory);
            }}
            style={[
              styles.pill,
              {
                backgroundColor: isActive ? c.primary : c.muted,
                borderColor: isActive ? c.primary : c.border,
              },
            ]}
          >
            <Text
              style={[
                styles.pillText,
                { color: isActive ? c.primaryForeground : c.mutedForeground },
              ]}
            >
              {item}
            </Text>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: 16,
    gap: 8,
    paddingVertical: 4,
  },
  pill: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  pillText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
});
