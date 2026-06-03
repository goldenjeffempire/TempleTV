/**
 * FeedbackModal — in-app feedback + bug report form.
 *
 * Three submission types:
 *   • Bug Report   — something is broken
 *   • Suggestion   — feature request or improvement
 *   • General      — anything else
 *
 * Sends to POST /api/feedback (public endpoint, rate-limited 10 / 10 min).
 * Includes app version and platform so the admin knows which build filed it.
 * Auth is optional — token is attached if the user is signed in.
 */

import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Constants from "expo-constants";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";
import { ensureFreshAccessToken } from "@/services/authApi";

type FeedbackType = "bug" | "suggestion" | "general";

interface TypeOption {
  value: FeedbackType;
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  description: string;
}

const TYPES: TypeOption[] = [
  { value: "bug",        label: "Bug Report",  icon: "alert-circle",     description: "Something isn't working" },
  { value: "suggestion", label: "Suggestion",  icon: "zap",              description: "An idea or improvement" },
  { value: "general",    label: "Feedback",    icon: "message-circle",   description: "General thoughts" },
];

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 2000;

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function FeedbackModal({ visible, onClose }: Props) {
  const c = useColors();
  const [type, setType] = useState<FeedbackType>("bug");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const scaleRef = useRef(new Animated.Value(0.95)).current;
  const opacityRef = useRef(new Animated.Value(0)).current;

  const appVersion: string =
    Constants.expoConfig?.version ?? "unknown";

  const animateIn = useCallback(() => {
    Animated.parallel([
      Animated.spring(scaleRef, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 5 }),
      Animated.timing(opacityRef, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [scaleRef, opacityRef]);

  const reset = useCallback(() => {
    setType("bug");
    setSubject("");
    setMessage("");
    setSubmitting(false);
    setSubmitted(false);
    scaleRef.setValue(0.95);
    opacityRef.setValue(0);
  }, [scaleRef, opacityRef]);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!subject.trim()) {
      Alert.alert("Subject required", "Please enter a brief subject.");
      return;
    }
    if (!message.trim()) {
      Alert.alert("Message required", "Please describe your feedback.");
      return;
    }

    setSubmitting(true);
    try {
      const base = getApiBase();
      let token: string | null = null;
      try {
        token = await ensureFreshAccessToken();
      } catch {
        // Auth is optional for feedback
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetchWithRetry(`${base}/api/feedback`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type,
          subject: subject.trim(),
          message: message.trim(),
          platform: Platform.OS,
          appVersion,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(json.message ?? `HTTP ${res.status}`);
      }

      setSubmitted(true);
    } catch (err) {
      Alert.alert(
        "Submission failed",
        "Your feedback couldn't be sent right now. Please try again later.",
      );
      if (__DEV__) console.warn("[FeedbackModal] submit error:", err);
    } finally {
      setSubmitting(false);
    }
  }, [type, subject, message, appVersion]);

  const selectedType = TYPES.find((t) => t.value === type)!;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleClose}
      onShow={animateIn}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: c.card, borderColor: c.border, transform: [{ scale: scaleRef }], opacity: opacityRef },
          ]}
        >
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: c.border }]}>
            <View style={[styles.headerIcon, { backgroundColor: c.primary + "1A" }]}>
              <Feather name={selectedType.icon} size={16} color={c.primary} />
            </View>
            <Text style={[styles.headerTitle, { color: c.foreground }]}>Send Feedback</Text>
            <Pressable onPress={handleClose} style={styles.closeBtn} hitSlop={10} accessibilityLabel="Close">
              <Feather name="x" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>

          {submitted ? (
            <SuccessState c={c} onClose={handleClose} />
          ) : (
            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Type selector */}
              <Text style={[styles.label, { color: c.mutedForeground }]}>TYPE</Text>
              <View style={styles.typeRow}>
                {TYPES.map((t) => {
                  const active = type === t.value;
                  return (
                    <Pressable
                      key={t.value}
                      onPress={() => setType(t.value)}
                      style={[
                        styles.typeCard,
                        {
                          backgroundColor: active ? c.primary + "1A" : c.background,
                          borderColor: active ? c.primary + "80" : c.border,
                        },
                      ]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={t.label}
                    >
                      <Feather name={t.icon} size={16} color={active ? c.primary : c.mutedForeground} />
                      <Text style={[styles.typeLabel, { color: active ? c.primary : c.foreground }]}>
                        {t.label}
                      </Text>
                      <Text style={[styles.typeDesc, { color: c.mutedForeground }]}>
                        {t.description}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Subject */}
              <Text style={[styles.label, { color: c.mutedForeground }]}>SUBJECT</Text>
              <TextInput
                style={[styles.input, { backgroundColor: c.background, borderColor: c.border, color: c.foreground }]}
                placeholder="Brief summary…"
                placeholderTextColor={c.mutedForeground}
                value={subject}
                onChangeText={(t) => setSubject(t.slice(0, MAX_SUBJECT))}
                returnKeyType="next"
                maxLength={MAX_SUBJECT}
                accessibilityLabel="Subject"
              />
              <Text style={[styles.charCount, { color: c.mutedForeground }]}>
                {subject.length}/{MAX_SUBJECT}
              </Text>

              {/* Message */}
              <Text style={[styles.label, { color: c.mutedForeground }]}>DETAILS</Text>
              <TextInput
                style={[styles.textarea, { backgroundColor: c.background, borderColor: c.border, color: c.foreground }]}
                placeholder={
                  type === "bug"
                    ? "Describe what happened, what you expected, and any steps to reproduce it…"
                    : type === "suggestion"
                    ? "Describe your idea or improvement…"
                    : "Share your thoughts…"
                }
                placeholderTextColor={c.mutedForeground}
                value={message}
                onChangeText={(t) => setMessage(t.slice(0, MAX_MESSAGE))}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
                maxLength={MAX_MESSAGE}
                accessibilityLabel="Feedback details"
              />
              <Text style={[styles.charCount, { color: c.mutedForeground }]}>
                {message.length}/{MAX_MESSAGE}
              </Text>

              {/* Submit */}
              <Pressable
                onPress={handleSubmit}
                disabled={submitting}
                style={({ pressed }) => [
                  styles.submitBtn,
                  { backgroundColor: c.primary, opacity: submitting || pressed ? 0.72 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Submit feedback"
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Feather name="send" size={15} color="#fff" />
                    <Text style={styles.submitText}>Send Feedback</Text>
                  </>
                )}
              </Pressable>
            </ScrollView>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SuccessState({ c, onClose }: { c: ReturnType<typeof useColors>; onClose: () => void }) {
  return (
    <View style={styles.successWrap}>
      <View style={[styles.successIcon, { backgroundColor: "#22c55e1A" }]}>
        <Feather name="check-circle" size={36} color="#22c55e" />
      </View>
      <Text style={[styles.successTitle, { color: c.foreground }]}>Thank you!</Text>
      <Text style={[styles.successSub, { color: c.mutedForeground }]}>
        Your feedback has been received. We read every submission and use it to improve the app.
      </Text>
      <Pressable
        onPress={onClose}
        style={({ pressed }) => [styles.submitBtn, { backgroundColor: c.primary, opacity: pressed ? 0.72 : 1, marginTop: 8 }]}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Text style={styles.submitText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: "90%",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
  },
  closeBtn: {
    padding: 4,
  },
  body: {
    flexGrow: 0,
  },
  bodyContent: {
    padding: 16,
    paddingBottom: 32,
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 4,
  },
  typeRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 4,
  },
  typeCard: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
    gap: 4,
  },
  typeLabel: {
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  typeDesc: {
    fontSize: 10,
    textAlign: "center",
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  textarea: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 110,
  },
  charCount: {
    fontSize: 11,
    textAlign: "right",
    marginBottom: 2,
  },
  submitBtn: {
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },
  submitText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  successWrap: {
    alignItems: "center",
    padding: 32,
    gap: 12,
  },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  successTitle: {
    fontSize: 22,
    fontWeight: "700",
  },
  successSub: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
