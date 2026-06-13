import React, { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { Logo } from "@/components/Logo";
import { useAuth } from "@/context/AuthContext";

/**
 * Premium auth-gate modal. Shown when a non-authenticated user tries
 * to play any video. Two CTAs (Sign Up Free / Log In) navigate to the
 * existing screens; the user's pending playback target is preserved
 * in AuthContext and resumed automatically after successful auth.
 *
 * Design goals:
 *  • Netflix-style polished spring-in animation, no jank
 *  • Single fullscreen surface, dismissible with a soft "Maybe later"
 *  • Aligned with the rest of the app's purple/JCTM brand identity
 *  • Hero copy emphasises *value* (free + benefits), not friction
 */
export function AuthGateModal() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isAuthGateOpen, closeAuthGate, pendingPlayback } = useAuth();

  const fade = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;
  const lift = useRef(new Animated.Value(40)).current;

  useEffect(() => {
    if (isAuthGateOpen) {
      // Reset then animate in. Spring-like ease with parallel fade for
      // a premium, weight-y feel that doesn't tax mobile GPUs.
      fade.setValue(0);
      scale.setValue(0.92);
      lift.setValue(40);
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 1,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(scale, {
          toValue: 1,
          tension: 80,
          friction: 11,
          useNativeDriver: true,
        }),
        Animated.spring(lift, {
          toValue: 0,
          tension: 80,
          friction: 11,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isAuthGateOpen, fade, scale, lift]);

  // "Maybe later" — close the gate AND immediately navigate to the pending
  // content so the user can watch without being forced to sign in first.
  // The auth prompt may reappear when they start a new piece of content,
  // but it will never block an active viewing session.
  const handleDismiss = () => {
    const target = pendingPlayback; // capture before closeAuthGate clears it
    closeAuthGate();
    if (target) {
      InteractionManager.runAfterInteractions(() => {
        router.push({ pathname: target.pathname as any, params: target.params });
      });
    }
  };

  const goToSignup = () => {
    closeAuthGate({ keepPending: true });
    // Wait for the close animation to settle before navigating so the
    // route push doesn't visually compete with the fade-out.
    InteractionManager.runAfterInteractions(() => router.push("/signup"));
  };

  const goToLogin = () => {
    closeAuthGate({ keepPending: true });
    InteractionManager.runAfterInteractions(() => router.push("/login"));
  };

  const reasonText =
    pendingPlayback?.reason ??
    "Create your free account to watch full sermons, sync your progress, and never miss a live service.";

  return (
    <Modal
      visible={isAuthGateOpen}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleDismiss}
    >
      <Animated.View style={[styles.backdrop, { opacity: fade }]}>
        {/* Tap-outside dismisses (non-blocking — they can also tap "Maybe later"). */}
        <Pressable style={StyleSheet.absoluteFill} onPress={handleDismiss} />

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: c.background,
              opacity: fade,
              transform: [{ scale }, { translateY: lift }],
              paddingBottom: insets.bottom + 28,
              paddingTop: 32,
            },
          ]}
        >
          {/* Hero gradient header with brand mark. */}
          <View style={styles.heroWrap}>
            <LinearGradient
              colors={["#6A0DAD", "#3a0571", "#1a0233"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.heroGradient}
            />
            <Logo style={styles.logo} />
          </View>

          <Pressable
            onPress={handleDismiss}
            hitSlop={16}
            style={[styles.closeBtn, { backgroundColor: c.secondary }]}
            accessibilityLabel="Close sign-up prompt"
          >
            <Feather name="x" size={18} color={c.foreground} />
          </Pressable>

          <Text style={[styles.heading, { color: c.foreground }]}>
            Sign up free to keep watching
          </Text>
          <Text style={[styles.subheading, { color: c.mutedForeground }]}>
            {reasonText}
          </Text>

          <View style={styles.benefitRow}>
            <Benefit color={c.primary} icon="play-circle" label="Unlimited sermons" />
            <Benefit color={c.primary} icon="bookmark" label="Save favourites" />
            <Benefit color={c.primary} icon="bell" label="Live alerts" />
            <Benefit color={c.primary} icon="refresh-cw" label="Sync progress" />
          </View>

          <Pressable
            onPress={goToSignup}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: c.primary, opacity: pressed ? 0.9 : 1 },
            ]}
          >
            <Text style={styles.primaryBtnText}>Sign up — it's free</Text>
            <Feather name="arrow-right" size={18} color="#fff" />
          </Pressable>

          <Pressable
            onPress={goToLogin}
            style={({ pressed }) => [
              styles.secondaryBtn,
              { borderColor: c.border, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[styles.secondaryBtnText, { color: c.foreground }]}>
              I already have an account
            </Text>
          </Pressable>

          <Pressable onPress={handleDismiss} style={styles.dismissBtn} hitSlop={8}>
            <Text style={[styles.dismissText, { color: c.mutedForeground }]}>
              {pendingPlayback ? "Continue watching without signing in" : "Maybe later"}
            </Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

function Benefit({
  icon,
  label,
  color,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  color: string;
}) {
  const c = useColors();
  return (
    <View style={styles.benefitItem}>
      <View style={[styles.benefitIcon, { backgroundColor: color + "1F" }]}>
        <Feather name={icon} size={16} color={color} />
      </View>
      <Text style={[styles.benefitText, { color: c.mutedForeground }]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const { width: WIN_W } = Dimensions.get("window");
const SHEET_MAX_WIDTH = Math.min(460, WIN_W - 24);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(5,5,12,0.78)",
    alignItems: "center",
    justifyContent: "flex-end",
    ...Platform.select({
      web: { backdropFilter: "blur(8px)" as any },
      default: {},
    }),
  },
  sheet: {
    width: "100%",
    maxWidth: SHEET_MAX_WIDTH,
    paddingHorizontal: 24,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    ...Platform.select({
      web: {
        borderRadius: 24,
        marginBottom: 24,
        boxShadow: "0 20px 60px rgba(0,0,0,0.55)" as any,
      },
      default: {
        shadowColor: "#000",
        shadowOpacity: 0.4,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: -8 },
        elevation: 24,
      },
    }),
  },
  heroWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 84,
    marginBottom: 18,
    borderRadius: 20,
    overflow: "hidden",
  },
  heroGradient: { ...StyleSheet.absoluteFillObject },
  logo: { width: 130, height: 56 },
  closeBtn: {
    position: "absolute",
    top: 16,
    right: 16,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    letterSpacing: -0.3,
  },
  subheading: {
    marginTop: 8,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  benefitRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 22,
    marginBottom: 22,
    gap: 8,
  },
  benefitItem: {
    flex: 1,
    alignItems: "center",
    gap: 6,
  },
  benefitIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  benefitText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
    lineHeight: 14,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderRadius: 14,
    marginBottom: 10,
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.2,
  },
  secondaryBtn: {
    height: 50,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  secondaryBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  dismissBtn: {
    alignItems: "center",
    paddingVertical: 12,
  },
  dismissText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
