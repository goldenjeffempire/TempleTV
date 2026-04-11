import React, { useEffect, useRef } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

interface LiveNotificationBannerProps {
  visible: boolean;
  title: string;
  onPress: () => void;
  onDismiss: () => void;
}

export function LiveNotificationBanner({
  visible,
  title,
  onPress,
  onDismiss,
}: LiveNotificationBannerProps) {
  const slideAnim = useRef(new Animated.Value(-100)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const ND = Platform.OS !== "web";
    Animated.spring(slideAnim, {
      toValue: visible ? 0 : -100,
      useNativeDriver: ND,
      damping: 18,
    }).start();

    if (visible) {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 700, useNativeDriver: ND }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: ND }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [visible, slideAnim, pulseAnim]);

  return (
    <Animated.View style={[styles.wrapper, { transform: [{ translateY: slideAnim }] }]}>
      <Animated.View style={[styles.container, { transform: [{ scale: pulseAnim }] }]}>
        <View style={styles.dot} />
        <View style={styles.textBlock}>
          <Text style={styles.label}>LIVE NOW</Text>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
        </View>
        <Pressable onPress={onPress} style={styles.watchBtn}>
          <Text style={styles.watchText}>Watch</Text>
        </Pressable>
        <Pressable onPress={onDismiss} hitSlop={12} style={styles.closeBtn}>
          <Feather name="x" size={16} color="rgba(255,255,255,0.7)" />
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a0030",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(106,13,173,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
    ...Platform.select({
      ios: {
        shadowColor: "#6A0DAD",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.4,
        shadowRadius: 12,
      },
      android: {
        elevation: 10,
      },
      web: {
        boxShadow: "0 4px 12px rgba(106,13,173,0.4)",
      },
    }),
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#FF0040",
  },
  textBlock: {
    flex: 1,
  },
  label: {
    color: "#FF0040",
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginTop: 1,
  },
  watchBtn: {
    backgroundColor: "#6A0DAD",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 12,
  },
  watchText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  closeBtn: {
    padding: 2,
  },
});
