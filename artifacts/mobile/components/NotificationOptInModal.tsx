import React, { useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

interface NotificationOptInModalProps {
  visible: boolean;
  onAllow: () => void;
  onDismiss: () => void;
}

interface BenefitRowProps {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  description: string;
}

function BenefitRow({ icon, title, description }: BenefitRowProps) {
  const c = useColors();
  return (
    <View style={styles.benefitRow}>
      <View style={[styles.benefitIcon, { backgroundColor: c.secondary }]}>
        <Feather name={icon} size={20} color={c.primary} />
      </View>
      <View style={styles.benefitText}>
        <Text style={[styles.benefitTitle, { color: c.foreground }]}>{title}</Text>
        <Text style={[styles.benefitDesc, { color: c.mutedForeground }]}>{description}</Text>
      </View>
    </View>
  );
}

export function NotificationOptInModal({
  visible,
  onAllow,
  onDismiss,
}: NotificationOptInModalProps) {
  const c = useColors();
  const slideAnim = useRef(new Animated.Value(300)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.spring(slideAnim, {
          toValue: 0,
          tension: 65,
          friction: 11,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 300,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, fadeAnim, slideAnim]);

  if (Platform.OS === "web") return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: c.card,
              borderColor: c.border,
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          {/* Handle bar */}
          <View style={[styles.handle, { backgroundColor: c.border }]} />

          {/* Bell icon */}
          <View style={[styles.iconCircle, { backgroundColor: c.secondary }]}>
            <Feather name="bell" size={32} color={c.primary} />
          </View>

          <Text style={[styles.title, { color: c.foreground }]}>
            Stay Connected
          </Text>
          <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
            Enable notifications so you never miss what Temple TV JCTM is sharing.
          </Text>

          <View style={styles.benefits}>
            <BenefitRow
              icon="radio"
              title="Live Service Alerts"
              description="Know the moment Temple TV goes live every Sunday"
            />
            <BenefitRow
              icon="book-open"
              title="New Sermon Uploads"
              description="Fresh sermons and teachings as soon as they're posted"
            />
            <BenefitRow
              icon="alert-circle"
              title="Emergency Announcements"
              description="Urgent ministry updates and important church notices"
            />
          </View>

          <Pressable
            onPress={onAllow}
            style={({ pressed }) => [
              styles.allowBtn,
              { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="bell" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.allowBtnText}>Enable Notifications</Text>
          </Pressable>

          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.laterBtn, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.laterBtnText, { color: c.mutedForeground }]}>
              Maybe Later
            </Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 24,
    paddingBottom: 40,
    paddingTop: 12,
    alignItems: "center",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 24,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 28,
    paddingHorizontal: 8,
  },
  benefits: {
    width: "100%",
    gap: 16,
    marginBottom: 32,
  },
  benefitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  benefitIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  benefitText: {
    flex: 1,
  },
  benefitTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  benefitDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
  },
  allowBtn: {
    width: "100%",
    height: 52,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  allowBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  laterBtn: {
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  laterBtnText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
});
