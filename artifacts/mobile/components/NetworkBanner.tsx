import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

interface NetworkBannerProps {
  visible: boolean;
}

export function NetworkBanner({ visible }: NetworkBannerProps) {
  const slideAnim = useRef(new Animated.Value(-50)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: visible ? 0 : -50,
      useNativeDriver: true,
      damping: 20,
    }).start();
  }, [visible, slideAnim]);

  return (
    <Animated.View
      style={[styles.container, { transform: [{ translateY: slideAnim }] }]}
      pointerEvents="none"
    >
      <Feather name="wifi-off" size={14} color="#FFF" />
      <Text style={styles.text}>No connection — showing cached content</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "#1a1a1a",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    gap: 8,
    zIndex: 100,
  },
  text: {
    color: "#FFFFFF",
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
});
