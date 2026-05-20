import React, { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

export interface EmergencyAlertData {
  alertId: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical" | "emergency";
  expiresAt?: string | null;
}

interface Props {
  alert: EmergencyAlertData;
  onDismiss?: () => void;
}

const SEVERITY_COLORS: Record<EmergencyAlertData["severity"], { bg: string; text: string; border: string; canDismiss: boolean }> = {
  info: { bg: "#1d4ed8", text: "#fff", border: "#3b82f6", canDismiss: true },
  warning: { bg: "#b45309", text: "#fff", border: "#f59e0b", canDismiss: true },
  critical: { bg: "#b91c1c", text: "#fff", border: "#ef4444", canDismiss: false },
  emergency: { bg: "#7f1d1d", text: "#fff", border: "#f87171", canDismiss: false },
};

/**
 * Mobile emergency alert banner — slides down from the top of the screen.
 * info/warning can be dismissed. critical/emergency stay until the server
 * broadcasts a NODE_HEALTH_CHANGED signal with dismissed: true.
 */
export function EmergencyBanner({ alert, onDismiss }: Props) {
  const insets = useSafeAreaInsets();
  const slideAnim = useState(() => new Animated.Value(-120))[0];
  const colors = SEVERITY_COLORS[alert.severity];

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();
  }, [slideAnim]);

  const handleDismiss = () => {
    if (!colors.canDismiss) return;
    Animated.timing(slideAnim, {
      toValue: -140,
      duration: 280,
      useNativeDriver: true,
    }).start(() => onDismiss?.());
  };

  const SEVERITY_LABELS: Record<EmergencyAlertData["severity"], string> = {
    info: "INFORMATION",
    warning: "ALERT",
    critical: "CRITICAL ALERT",
    emergency: "EMERGENCY BROADCAST",
  };

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
          backgroundColor: colors.bg,
          borderBottomColor: colors.border,
          paddingTop: insets.top + 10,
        },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <View style={styles.inner}>
        <Feather
          name={alert.severity === "emergency" || alert.severity === "critical" ? "alert-triangle" : "info"}
          size={20}
          color={colors.text}
          style={styles.icon}
        />
        <View style={styles.textBlock}>
          <Text style={[styles.label, { color: colors.text + "bb" }]}>
            {SEVERITY_LABELS[alert.severity]}
          </Text>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {alert.title}
          </Text>
          <Text style={[styles.message, { color: colors.text + "cc" }]} numberOfLines={2}>
            {alert.message}
          </Text>
        </View>
        {colors.canDismiss && (
          <Pressable onPress={handleDismiss} style={styles.dismissBtn} hitSlop={12}>
            <Feather name="x" size={18} color={colors.text} />
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    borderBottomWidth: 1.5,
    paddingBottom: 12,
    paddingHorizontal: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 12,
  },
  inner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingTop: 4,
  },
  icon: {
    marginTop: 2,
    flexShrink: 0,
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1.5,
    marginBottom: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18,
  },
  message: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  dismissBtn: {
    flexShrink: 0,
    padding: 4,
    marginTop: 2,
  },
});
