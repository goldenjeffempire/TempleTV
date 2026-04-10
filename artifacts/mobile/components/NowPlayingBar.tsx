import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

interface NowPlayingBarProps {
  title: string;
  isLive?: boolean;
}

export function NowPlayingBar({ title, isLive = false }: NowPlayingBarProps) {
  const c = useColors();
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isLive) return;
    const glow = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1500, useNativeDriver: true }),
      ]),
    );
    glow.start();
    return () => glow.stop();
  }, [isLive, glowAnim]);

  return (
    <View style={[styles.container, { backgroundColor: c.surfaceGlass, borderColor: c.border }]}>
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
        <Text style={[styles.label, { color: c.mutedForeground }]}>
          {isLive ? "NOW LIVE" : "NOW PLAYING"}
        </Text>
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </View>
  );
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
});
