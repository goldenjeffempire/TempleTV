import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useColors } from "@/hooks/useColors";
import { submitPrayerRequest } from "@/services/broadcast";

interface PrayerRequestModalProps {
  visible: boolean;
  onClose: () => void;
}

type Phase = "form" | "submitting" | "success";

export function PrayerRequestModal({ visible, onClose }: PrayerRequestModalProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(40)).current;

  React.useEffect(() => {
    if (visible) {
      fade.setValue(0);
      lift.setValue(40);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }),
        Animated.spring(lift, { toValue: 0, tension: 80, friction: 11, useNativeDriver: Platform.OS !== "web" }),
      ]).start();
    } else {
      setPhase("form");
      setName("");
      setMessage("");
      setError(null);
    }
  }, [visible]);

  const handleSubmit = async () => {
    if (!message.trim()) {
      setError("Please write your prayer request.");
      return;
    }
    setError(null);
    setPhase("submitting");
    const ok = await submitPrayerRequest(name.trim() || null, message.trim());
    if (ok) {
      setPhase("success");
    } else {
      setPhase("form");
      setError("Something went wrong. Please try again.");
    }
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Animated.View style={[styles.backdrop, StyleSheet.absoluteFill, { opacity: fade }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: c.background,
              opacity: fade,
              transform: [{ translateY: lift }],
              paddingBottom: insets.bottom + 24,
              paddingTop: 28,
            },
          ]}
        >
          <LinearGradient
            colors={["#6A0DAD", "#3a0571", "#1a0233"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.headerGradient}
          >
            <Text style={styles.headerEmoji}>🙏</Text>
            <Text style={styles.headerTitle}>Prayer Request</Text>
            <Text style={styles.headerSub}>
              Your request will be received by the prayer team.
            </Text>
          </LinearGradient>

          <Pressable
            onPress={handleClose}
            hitSlop={16}
            style={[styles.closeBtn, { backgroundColor: c.secondary }]}
            accessibilityLabel="Close prayer request"
          >
            <Feather name="x" size={18} color={c.foreground} />
          </Pressable>

          {phase === "success" ? (
            <View style={styles.successWrap}>
              <View style={[styles.successIcon, { backgroundColor: "rgba(106,13,173,0.15)" }]}>
                <Feather name="check-circle" size={36} color="#6A0DAD" />
              </View>
              <Text style={[styles.successTitle, { color: c.foreground }]}>
                Prayer received
              </Text>
              <Text style={[styles.successSub, { color: c.mutedForeground }]}>
                The prayer team will intercede on your behalf.
              </Text>
              <Pressable
                onPress={handleClose}
                style={({ pressed }) => [styles.submitBtn, { backgroundColor: "#6A0DAD", opacity: pressed ? 0.85 : 1, marginTop: 24 }]}
              >
                <Text style={styles.submitBtnText}>Close</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.form}>
              <Text style={[styles.fieldLabel, { color: c.mutedForeground }]}>
                Your name (optional)
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="e.g. Grace A."
                placeholderTextColor={c.mutedForeground}
                style={[styles.input, { color: c.foreground, borderColor: c.border, backgroundColor: c.secondary }]}
                editable={phase === "form"}
                returnKeyType="next"
                autoCapitalize="words"
              />

              <Text style={[styles.fieldLabel, { color: c.mutedForeground, marginTop: 16 }]}>
                Prayer request *
              </Text>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="Share what's on your heart…"
                placeholderTextColor={c.mutedForeground}
                style={[
                  styles.input,
                  styles.messageInput,
                  { color: c.foreground, borderColor: c.border, backgroundColor: c.secondary },
                ]}
                multiline
                numberOfLines={4}
                editable={phase === "form"}
                textAlignVertical="top"
              />

              {error && (
                <Text style={styles.errorText}>{error}</Text>
              )}

              <Pressable
                onPress={handleSubmit}
                disabled={phase !== "form"}
                style={({ pressed }) => [
                  styles.submitBtn,
                  { backgroundColor: "#6A0DAD", opacity: phase !== "form" || pressed ? 0.75 : 1 },
                ]}
              >
                {phase === "submitting" ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Feather name="send" size={16} color="#fff" />
                    <Text style={styles.submitBtnText}>Send Prayer Request</Text>
                  </>
                )}
              </Pressable>
            </View>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const { width: WIN_W } = Dimensions.get("window");
const SHEET_MAX_W = Math.min(460, WIN_W - 24);

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
    maxWidth: SHEET_MAX_W,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: "hidden",
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
  headerGradient: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    alignItems: "center",
    gap: 6,
  },
  headerEmoji: {
    fontSize: 32,
    marginBottom: 4,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.2,
  },
  headerSub: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  closeBtn: {
    position: "absolute",
    top: 16,
    right: 16,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  form: {
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  messageInput: {
    height: 110,
    paddingTop: 11,
  },
  errorText: {
    color: "#ef4444",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    marginTop: 8,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderRadius: 14,
    marginTop: 20,
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.2,
  },
  successWrap: {
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  successTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  successSub: {
    marginTop: 8,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
});
