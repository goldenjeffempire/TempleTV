import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet, Text, useColorScheme, View } from "react-native";
import { Feather } from "@expo/vector-icons";

interface NetworkBannerProps {
  /** Show the amber offline banner */
  visible: boolean;
  /**
   * When true, briefly shows a green "Back online" recovery flash instead of
   * the amber offline banner. The caller is responsible for clearing this flag
   * after the flash duration (NetworkContext does this automatically).
   */
  recovered?: boolean;
  /**
   * Optional override for the offline banner copy.
   * Defaults to "No connection — retrying…" which is accurate for all surfaces
   * now that the fetch layer retries automatically.
   */
  message?: string;
}

export function NetworkBanner({ visible, recovered = false, message }: NetworkBannerProps) {
  const slideAnim = useRef(new Animated.Value(-52)).current;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  const shouldShow = visible || recovered;

  useEffect(() => {
    const ND = Platform.OS !== "web";
    Animated.spring(slideAnim, {
      toValue: shouldShow ? 0 : -52,
      useNativeDriver: ND,
      damping: 22,
      stiffness: 200,
    }).start();
  }, [shouldShow, slideAnim]);

  const bgColor = recovered
    ? isDark ? "rgba(10, 40, 20, 0.96)" : "rgba(5, 30, 15, 0.92)"
    : isDark ? "rgba(30, 10, 50, 0.96)" : "rgba(15, 5, 25, 0.92)";

  const iconName: "wifi" | "wifi-off" = recovered ? "wifi" : "wifi-off";
  const iconColor = recovered ? "#69DB7C" : "#FFA94D";
  const iconBg = recovered ? "rgba(105, 219, 124, 0.18)" : "rgba(255, 169, 77, 0.18)";
  const textColor = recovered ? "#A3E8B0" : "#FFC97A";
  const label = recovered ? "Back online" : (message ?? "No connection — retrying…");

  return (
    <Animated.View
      style={[
        styles.container,
        { backgroundColor: bgColor, transform: [{ translateY: slideAnim }], pointerEvents: "none" },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion={recovered ? "polite" : "assertive"}
      accessibilityLabel={label}
    >
      <View style={[styles.iconWrap, { backgroundColor: iconBg }]}>
        <Feather name={iconName} size={13} color={iconColor} />
      </View>
      <Text style={[styles.text, { color: textColor }]}>{label}</Text>
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
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
});
