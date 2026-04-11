import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet, Text, useColorScheme, View } from "react-native";
import { Feather } from "@expo/vector-icons";

interface NetworkBannerProps {
  visible: boolean;
}

export function NetworkBanner({ visible }: NetworkBannerProps) {
  const slideAnim = useRef(new Animated.Value(-52)).current;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  useEffect(() => {
    const ND = Platform.OS !== "web";
    Animated.spring(slideAnim, {
      toValue: visible ? 0 : -52,
      useNativeDriver: ND,
      damping: 22,
      stiffness: 200,
    }).start();
  }, [visible, slideAnim]);

  const bgColor = isDark ? "rgba(30, 10, 50, 0.96)" : "rgba(15, 5, 25, 0.92)";

  return (
    <Animated.View
      style={[styles.container, { backgroundColor: bgColor, transform: [{ translateY: slideAnim }], pointerEvents: "none" }]}
    >
      <View style={styles.iconWrap}>
        <Feather name="wifi-off" size={13} color="#FFA94D" />
      </View>
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
    zIndex: 100,
  },
  iconWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(255, 169, 77, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    color: "#FFC97A",
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
});
