import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import type { Sermon } from "@/types";
import colors from "@/constants/colors";

interface SermonCardProps {
  sermon: Sermon;
  onPress: (sermon: Sermon) => void;
  variant?: "horizontal" | "vertical";
}

export function SermonCard({ sermon, onPress, variant = "vertical" }: SermonCardProps) {
  const c = useColors();

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress(sermon);
  };

  if (variant === "horizontal") {
    return (
      <Pressable
        onPress={handlePress}
        style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
      >
        <GlassCard style={styles.horizontalCard}>
          <Image source={{ uri: sermon.thumbnailUrl }} style={styles.horizontalThumb} />
          <View style={styles.horizontalInfo}>
            <Text style={[styles.title, { color: c.foreground }]} numberOfLines={2}>
              {sermon.title}
            </Text>
            <Text style={[styles.meta, { color: c.mutedForeground }]}>
              {sermon.preacher}
            </Text>
            <View style={styles.metaRow}>
              <Feather name="clock" size={12} color={c.mutedForeground} />
              <Text style={[styles.duration, { color: c.mutedForeground }]}>{sermon.duration}</Text>
              <View style={[styles.categoryBadge, { backgroundColor: c.secondary }]}>
                <Text style={[styles.categoryText, { color: c.accent }]}>{sermon.category}</Text>
              </View>
            </View>
          </View>
        </GlassCard>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.verticalCard,
        { opacity: pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
      ]}
    >
      <View style={[styles.thumbContainer, { borderRadius: colors.radius }]}>
        <Image source={{ uri: sermon.thumbnailUrl }} style={styles.verticalThumb} />
        <View style={styles.durationBadge}>
          <Text style={styles.durationBadgeText}>{sermon.duration}</Text>
        </View>
      </View>
      <Text style={[styles.title, { color: c.foreground }]} numberOfLines={2}>
        {sermon.title}
      </Text>
      <Text style={[styles.meta, { color: c.mutedForeground }]}>{sermon.preacher}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  verticalCard: {
    width: 200,
    gap: 8,
  },
  thumbContainer: {
    overflow: "hidden",
    position: "relative",
  },
  verticalThumb: {
    width: 200,
    height: 112,
    backgroundColor: "#1a1a1a",
  },
  durationBadge: {
    position: "absolute",
    bottom: 6,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  durationBadgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  horizontalCard: {
    flexDirection: "row",
    padding: 12,
    gap: 12,
  },
  horizontalThumb: {
    width: 120,
    height: 68,
    borderRadius: 8,
    backgroundColor: "#1a1a1a",
  },
  horizontalInfo: {
    flex: 1,
    justifyContent: "center",
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 18,
  },
  meta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  duration: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    marginLeft: 4,
  },
  categoryText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
  },
});
