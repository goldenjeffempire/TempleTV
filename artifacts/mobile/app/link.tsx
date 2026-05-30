import React, { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/context/AuthContext";
import { apiClaimDeviceCode } from "@/services/deviceLinkApi";
import { usePageSeo } from "@/hooks/usePageSeo";

/**
 * /link — TV pairing page. The user opens this on their phone, types
 * the 8-character code shown on the TV, and confirms. If they aren't
 * signed in we route them to /login first; their pending action is
 * preserved by AuthContext so they land back here on success.
 *
 * Code format is "ABCD-1234" (case-insensitive); we sanitise on input.
 */
export default function LinkTvScreen() {
  usePageSeo({
    title: "Link your TV | Temple TV",
    description: "Pair your Temple TV smart-TV app with your account by entering the on-screen code.",
    path: "/link",
    noindex: true,
  });

  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isLoggedIn, openAuthGate } = useAuth();

  const [raw, setRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Display as ABCD-1234 while keeping internal value alphanumeric.
  const formatted = formatCode(raw);

  const handleChange = (next: string) => {
    const clean = next.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
    setRaw(clean);
  };

  const handleSubmit = async () => {
    if (raw.length !== 8) {
      Alert.alert("Code incomplete", "Please enter all 8 characters.");
      return;
    }
    if (!isLoggedIn) {
      // Route through the same gate so /login knows where to come back to.
      openAuthGate({
        pathname: "/link",
        params: {},
        reason: "Sign in to finish linking your TV.",
      });
      return;
    }
    setSubmitting(true);
    try {
      await apiClaimDeviceCode(raw);
      setDone(true);
    } catch (err) {
      Alert.alert(
        "Link failed",
        err instanceof Error ? err.message : "Please double-check the code on your TV.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: c.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
            <Feather name="x" size={22} color={c.foreground} />
          </Pressable>
        </View>

        <View style={[styles.iconWrap, { backgroundColor: c.primary + "1F" }]}>
          <Feather name="tv" size={32} color={c.primary} />
        </View>

        <Text style={[styles.heading, { color: c.foreground }]}>Link your TV</Text>
        <Text style={[styles.sub, { color: c.mutedForeground }]}>
          Enter the 8-character code shown on your Temple TV smart-TV app.
        </Text>

        {done ? (
          <View style={[styles.successCard, { backgroundColor: c.secondary }]}>
            <Feather name="check-circle" size={28} color="#22c55e" />
            <Text style={[styles.successText, { color: c.foreground }]}>
              Your TV is linked
            </Text>
            <Text style={[styles.successSub, { color: c.mutedForeground }]}>
              You can return to your TV — it will switch to your account in a few seconds.
            </Text>
            <Pressable
              onPress={() => router.replace("/(tabs)/channels")}
              style={[styles.primaryBtn, { backgroundColor: c.primary, marginTop: 18 }]}
            >
              <Text style={styles.primaryBtnText}>Done</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <TextInput
              style={[
                styles.codeInput,
                {
                  borderColor: c.border,
                  color: c.foreground,
                  backgroundColor: c.secondary,
                },
              ]}
              value={formatted}
              onChangeText={handleChange}
              placeholder="ABCD-1234"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              maxLength={9}
              editable={!submitting}
            />

            <Pressable
              onPress={handleSubmit}
              disabled={submitting || raw.length !== 8}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: c.primary,
                  opacity: submitting || raw.length !== 8 ? 0.5 : pressed ? 0.9 : 1,
                },
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>Link TV</Text>
              )}
            </Pressable>

            <Text style={[styles.hint, { color: c.mutedForeground }]}>
              The code expires after 10 minutes. If it's expired, refresh the screen on your TV.
            </Text>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function formatCode(raw: string): string {
  if (raw.length <= 4) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingHorizontal: 24 },
  headerRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 8 },
  backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  iconWrap: {
    alignSelf: "center",
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
    marginBottom: 18,
  },
  heading: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    letterSpacing: -0.3,
  },
  sub: {
    marginTop: 8,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  codeInput: {
    marginTop: 24,
    height: 64,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 18,
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    letterSpacing: 6,
    textAlign: "center",
  },
  primaryBtn: {
    marginTop: 18,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.2,
  },
  hint: {
    marginTop: 16,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 18,
  },
  successCard: {
    marginTop: 18,
    padding: 24,
    borderRadius: 18,
    alignItems: "center",
  },
  successText: {
    marginTop: 12,
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  successSub: {
    marginTop: 6,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 18,
  },
});
