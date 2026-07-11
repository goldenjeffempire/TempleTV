import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { apiChangePassword, ChangePasswordMfaRequiredError } from "@/services/authApi";

export default function ChangePasswordScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  // Set once the server rejects the request with "TOTP code required" —
  // switches the form into a second step asking for the 6-digit code instead
  // of dead-ending the user with an unactionable error (previously the app
  // had no way at all to change the password on an MFA-enabled account).
  const [needsMfaCode, setNeedsMfaCode] = useState(false);
  const [mfaCode, setMfaCode] = useState("");

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  async function submitChange(totpCode?: string) {
    setLoading(true);
    try {
      await apiChangePassword(currentPassword, newPassword, totpCode);
      if (!mountedRef.current) return;
      Alert.alert("Password Updated", "Your password has been changed successfully.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if (err instanceof ChangePasswordMfaRequiredError) {
        setNeedsMfaCode(true);
        if (totpCode) Alert.alert("Invalid Code", "That code is incorrect or has expired. Please try again.");
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to change password.";
      Alert.alert("Error", message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  async function handleSubmit() {
    if (needsMfaCode) {
      if (!/^\d{6}$/.test(mfaCode)) {
        Alert.alert("Invalid Code", "Enter the 6-digit code from your authenticator app.");
        return;
      }
      await submitChange(mfaCode);
      return;
    }
    if (!currentPassword || !newPassword || !confirmPassword) {
      Alert.alert("Missing Fields", "Please fill in all fields.");
      return;
    }
    if (newPassword.length < 8) {
      Alert.alert("Weak Password", "New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Passwords Don't Match", "New password and confirmation must match.");
      return;
    }
    await submitChange();
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: c.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Feather name="x" size={22} color={c.mutedForeground} />
          </Pressable>
        </View>

        <Text style={[styles.title, { color: c.foreground }]}>Change Password</Text>
        <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
          {needsMfaCode
            ? "Two-factor authentication is enabled on your account. Enter the 6-digit code from your authenticator app to confirm the change."
            : "Enter your current password and choose a new one."}
        </Text>

        {needsMfaCode ? (
          <View style={styles.fields}>
            <Text style={[styles.label, { color: c.mutedForeground }]}>Authentication Code</Text>
            <View style={[styles.inputWrap, { backgroundColor: c.card, borderColor: c.border }]}>
              <Feather name="shield" size={16} color={c.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: c.foreground, letterSpacing: 4 }]}
                value={mfaCode}
                onChangeText={(t) => setMfaCode(t.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="123456"
                placeholderTextColor={c.mutedForeground}
                keyboardType="number-pad"
                autoFocus
                maxLength={6}
              />
            </View>
            <Pressable
              style={{ marginTop: 12 }}
              onPress={() => { setNeedsMfaCode(false); setMfaCode(""); }}
              hitSlop={8}
            >
              <Text style={[styles.backLink, { color: c.mutedForeground }]}>Back</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.fields}>
            <Text style={[styles.label, { color: c.mutedForeground }]}>Current Password</Text>
            <View style={[styles.inputWrap, { backgroundColor: c.card, borderColor: c.border }]}>
              <Feather name="lock" size={16} color={c.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: c.foreground }]}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder="Current password"
                placeholderTextColor={c.mutedForeground}
                secureTextEntry={!showCurrent}
                autoComplete="current-password"
                textContentType="password"
              />
              <Pressable onPress={() => setShowCurrent((v) => !v)} hitSlop={8}>
                <Feather name={showCurrent ? "eye-off" : "eye"} size={18} color={c.mutedForeground} />
              </Pressable>
            </View>

            <Text style={[styles.label, { color: c.mutedForeground, marginTop: 16 }]}>New Password</Text>
            <View style={[styles.inputWrap, { backgroundColor: c.card, borderColor: c.border }]}>
              <Feather name="key" size={16} color={c.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: c.foreground }]}
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="At least 8 characters"
                placeholderTextColor={c.mutedForeground}
                secureTextEntry={!showNew}
                autoComplete="new-password"
                textContentType="newPassword"
              />
              <Pressable onPress={() => setShowNew((v) => !v)} hitSlop={8}>
                <Feather name={showNew ? "eye-off" : "eye"} size={18} color={c.mutedForeground} />
              </Pressable>
            </View>

            <Text style={[styles.label, { color: c.mutedForeground, marginTop: 16 }]}>Confirm New Password</Text>
            <View style={[styles.inputWrap, { backgroundColor: c.card, borderColor: c.border }]}>
              <Feather name="key" size={16} color={c.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: c.foreground }]}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Repeat new password"
                placeholderTextColor={c.mutedForeground}
                secureTextEntry={!showConfirm}
                autoComplete="new-password"
                textContentType="newPassword"
              />
              <Pressable onPress={() => setShowConfirm((v) => !v)} hitSlop={8}>
                <Feather name={showConfirm ? "eye-off" : "eye"} size={18} color={c.mutedForeground} />
              </Pressable>
            </View>
          </View>
        )}

        <Pressable
          style={[styles.submitBtn, { backgroundColor: c.primary, opacity: loading ? 0.7 : 1 }]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.submitText}>{needsMfaCode ? "Confirm Code" : "Update Password"}</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24 },
  headerRow: { marginBottom: 32 },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", marginBottom: 8 },
  subtitle: { fontSize: 14, fontFamily: "Inter_400Regular", marginBottom: 32, lineHeight: 20 },
  fields: { gap: 0 },
  label: { fontSize: 12, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 52,
  },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular" },
  submitBtn: {
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 32,
  },
  submitText: { color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  backLink: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
