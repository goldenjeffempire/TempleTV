import React, { useEffect, useRef } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

const ND = Platform.OS !== "web";

interface NowPlayingBarProps {
  title: string;
  isLive?: boolean;
  onPress?: () => void;
}

export function NowPlayingBar({ title, isLive = false, onPress }: NowPlayingBarProps) {
  const c = useColors();
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isLive) return;
    const glow = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1500, useNativeDriver: ND }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1500, useNativeDriver: ND }),
      ]),
    );
    glow.start();
    return () => glow.stop();
  }, [isLive, glowAnim]);

  const inner = (
    <View style={[styles.container, { backgroundColor: c.surfaceGlass, borderColor: isLive ? "rgba(255,0,64,0.3)" : c.border }]}>
      <Animated.View
        style={[
          styles.iconWrap,
          {
            backgroundColor: isLive ? "#FF0040" : c.primary,
            opacity: isLive ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) : 1,
          },
        ]}
      >
        <Feather name={isLive ? "radio" : "music"} size={14} color="#FFF" />
      </Animated.View>
      <View style={styles.textWrap}>
        <Text style={[styles.label, { color: isLive ? "#FF0040" : c.mutedForeground }]}>
          {isLive ? "NOW LIVE" : "NOW PLAYING"}
        </Text>
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
          {isLive ? "Temple TV" : title}
        </Text>
      </View>
      {onPress && (
        <View style={[styles.chevronWrap, { backgroundColor: isLive ? "rgba(255,0,64,0.12)" : c.muted }]}>
          <Feather name="chevron-right" size={16} color={isLive ? "#FF0040" : c.mutedForeground} />
        </View>
      )}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [{ opacity: pressed ? 0.82 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
      >
        {inner}
      </Pressable>
    );
  }

  return inner;
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    marginHorizontal: 16,
    marginVertical: 8,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  textWrap: {
    flex: 1,
  },
  label: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
  },
  title: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginTop: 2,
  },
  chevronWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
