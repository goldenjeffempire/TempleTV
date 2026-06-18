import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useRef, useState, useEffect } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { apiResetPassword, validatePasswordStrength } from "@/services/authApi";
import { Logo } from "@/components/Logo";

/**
 * Reset-password screen — opened via deep link from the email:
 *   templetv://reset-password?token=...
 *   https://templetv.org.ng/reset-password?token=...   (universal link fallback)
 */
export default function ResetPasswordScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token : "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mountedRef = useRef(true);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 420, useNativeDriver: true }).start();
  }, []);

  const handleSubmit = async () => {
    setError(null);
    if (!token) {
      setError("This reset link is missing its security token. Please open the link from your email directly.");
      return;
    }
    const weak = validatePasswordStrength(password);
    if (weak) { setError(weak); return; }
    if (password !== confirm) { setError("Passwords don't match. Please try again."); return; }

    setLoading(true);
    try {
      await apiResetPassword(token, password);
      if (mountedRef.current) setDone(true);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "Couldn't reset your password. Please try again.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      <LinearGradient
        colors={["#0d0014", "#160a28", "#0a0010"]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.accentBlur, { top: -60, right: -80 }]} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 48 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
            <View style={styles.logoWrap}>
              <Logo size="lg" />
            </View>

            {done ? (
              <>
                <View style={styles.iconCircle}>
                  <Feather name="check-circle" size={28} color="#22c55e" />
                </View>
                <Text style={styles.title}>Password updated</Text>
                <Text style={styles.subtitle}>
                  Your password has been changed. All other devices were signed out for safety.
                </Text>
                <Pressable onPress={() => router.replace("/login")} style={[styles.submitBtnOuter, { marginTop: 12 }]}>
                  <LinearGradient
                    colors={["#7c3aed", "#6d28d9", "#5b21b6"]}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.submitBtn}
                  >
                    <Text style={styles.submitText}>Sign in</Text>
                  </LinearGradient>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.title}>Choose a new password</Text>
                <Text style={styles.subtitle}>Pick something at least 8 characters long that you'll remember.</Text>

                <View style={styles.form}>
                  <Text style={styles.label}>NEW PASSWORD</Text>
                  <View style={styles.inputRow}>
                    <Feather name="lock" size={17} color="rgba(255,255,255,0.45)" style={{ marginRight: 10 }} />
                    <TextInput
                      style={styles.input}
                      value={password}
                      onChangeText={setPassword}
                      placeholder="At least 8 characters"
                      placeholderTextColor="rgba(255,255,255,0.25)"
                      secureTextEntry={!showPassword}
                      autoComplete="new-password"
                      textContentType="newPassword"
                      returnKeyType="next"
                    />
                    <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8}>
                      <Feather name={showPassword ? "eye-off" : "eye"} size={17} color="rgba(255,255,255,0.4)" />
                    </Pressable>
                  </View>

                  <Text style={[styles.label, { marginTop: 16 }]}>CONFIRM NEW PASSWORD</Text>
                  <View style={styles.inputRow}>
                    <Feather name="shield" size={17} color="rgba(255,255,255,0.45)" style={{ marginRight: 10 }} />
                    <TextInput
                      style={styles.input}
                      value={confirm}
                      onChangeText={setConfirm}
                      placeholder="Repeat your new password"
                      placeholderTextColor="rgba(255,255,255,0.25)"
                      secureTextEntry={!showPassword}
                      autoComplete="new-password"
                      textContentType="newPassword"
                      returnKeyType="done"
                      onSubmitEditing={handleSubmit}
                    />
                  </View>

                  {error && (
                    <View style={styles.errorBox}>
                      <Feather name="alert-circle" size={14} color="#f87171" />
                      <Text style={styles.errorText}>{error}</Text>
                    </View>
                  )}

                  <Pressable onPress={handleSubmit} disabled={loading} style={[styles.submitBtnOuter, { marginTop: 28 }]}>
                    <LinearGradient
                      colors={["#7c3aed", "#6d28d9", "#5b21b6"]}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                      style={styles.submitBtn}
                    >
                      {loading ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={styles.submitText}>Update password</Text>}
                    </LinearGradient>
                  </Pressable>
                </View>

                <Pressable onPress={() => router.replace("/login")} style={styles.cancelBtn} hitSlop={8}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </>
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d0014" },
  flex: { flex: 1 },
  accentBlur: {
    position: "absolute", width: 280, height: 280, borderRadius: 140,
    backgroundColor: "rgba(109,40,217,0.18)",
  },
  scroll: { flexGrow: 1, paddingHorizontal: 28 },
  content: { flex: 1 },
  logoWrap: { alignItems: "center", marginTop: 60, marginBottom: 28 },
  iconCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: "rgba(34,197,94,0.12)",
    alignItems: "center", justifyContent: "center",
    alignSelf: "center", marginBottom: 18,
  },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", color: "#fff", textAlign: "center", marginBottom: 10, letterSpacing: -0.3 },
  subtitle: {
    fontSize: 14, fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.5)", textAlign: "center",
    lineHeight: 21, marginBottom: 28,
  },
  form: {},
  label: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.4)", letterSpacing: 1.2, marginBottom: 8 },
  inputRow: {
    flexDirection: "row", alignItems: "center",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 14, paddingHorizontal: 14, height: 54,
  },
  input: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular", color: "#fff" },
  errorBox: {
    flexDirection: "row", alignItems: "center", gap: 7,
    backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 1, borderColor: "rgba(239,68,68,0.25)", marginTop: 12,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", color: "#f87171", lineHeight: 18 },
  submitBtnOuter: { borderRadius: 14, overflow: "hidden" },
  submitBtn: { height: 54, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 10 },
  submitText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold", letterSpacing: 0.2 },
  cancelBtn: { alignItems: "center", paddingVertical: 18 },
  cancelText: { fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.45)", textDecorationLine: "underline" },
});
