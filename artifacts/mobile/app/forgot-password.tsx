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
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { apiForgotPassword, isValidEmail } from "@/services/authApi";
import { Logo } from "@/components/Logo";

export default function ForgotPasswordScreen() {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 420, useNativeDriver: true }).start();
  }, []);

  const handleSubmit = async () => {
    setError(null);
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !isValidEmail(trimmed)) {
      setError("Please enter the email address on your account.");
      return;
    }
    setLoading(true);
    try {
      await apiForgotPassword(trimmed);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the reset email. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={["#0d0014", "#160a28", "#0a0010"]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.accentBlur, { top: -60, right: -80 }]} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 48 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={() => router.canGoBack() ? router.back() : router.replace("/login")}
            style={[styles.backBtn, { top: insets.top + 8 }]}
            hitSlop={8}
          >
            <View style={styles.backBtnInner}>
              <Feather name="arrow-left" size={18} color="rgba(255,255,255,0.7)" />
            </View>
          </Pressable>

          <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
            <View style={styles.logoWrap}>
              <Logo style={styles.logo} />
            </View>

            {sent ? (
              <>
                <View style={styles.iconCircle}>
                  <Feather name="mail" size={28} color="#a78bfa" />
                </View>
                <Text style={styles.title}>Check your inbox</Text>
                <Text style={styles.subtitle}>
                  If an account exists for{" "}
                  <Text style={styles.subtitleEmphasis}>{email.trim().toLowerCase()}</Text>, we just
                  sent a link you can use to reset your password. The link expires in 30 minutes.
                </Text>

                <Pressable onPress={() => router.replace("/login")} style={styles.submitBtnOuter}>
                  <LinearGradient
                    colors={["#7c3aed", "#6d28d9", "#5b21b6"]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.submitBtn}
                  >
                    <Text style={styles.submitText}>Back to sign in</Text>
                  </LinearGradient>
                </Pressable>

                <Pressable
                  onPress={() => { setSent(false); setError(null); }}
                  style={styles.resendBtn}
                  hitSlop={8}
                >
                  <Text style={styles.resendText}>Didn't get it? Try a different email</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.title}>Reset your password</Text>
                <Text style={styles.subtitle}>
                  Enter the email on your account and we'll send you a secure link to choose a new password.
                </Text>

                <View style={styles.form}>
                  <Text style={styles.label}>EMAIL ADDRESS</Text>
                  <View style={styles.inputRow}>
                    <Feather name="mail" size={17} color="rgba(255,255,255,0.45)" style={{ marginRight: 10 }} />
                    <TextInput
                      style={styles.input}
                      value={email}
                      onChangeText={setEmail}
                      placeholder="you@example.com"
                      placeholderTextColor="rgba(255,255,255,0.25)"
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoComplete="email"
                      returnKeyType="send"
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
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={styles.submitBtn}
                    >
                      {loading ? (
                        <ActivityIndicator color="#FFF" size="small" />
                      ) : (
                        <Text style={styles.submitText}>Send reset link</Text>
                      )}
                    </LinearGradient>
                  </Pressable>
                </View>

                <Pressable onPress={() => router.replace("/login")} style={styles.resendBtn} hitSlop={8}>
                  <Text style={styles.resendText}>Remembered it? Back to sign in</Text>
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
    position: "absolute",
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: "rgba(109,40,217,0.18)",
  },
  scroll: { flexGrow: 1, paddingHorizontal: 28 },
  backBtn: { position: "absolute", left: 16, zIndex: 10 },
  backBtnInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  content: { flex: 1, alignItems: "stretch" },
  logoWrap: { alignItems: "center", marginTop: 60, marginBottom: 28 },
  logo: { width: 120, height: 52 },
  iconCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: "rgba(139,92,246,0.15)",
    alignItems: "center", justifyContent: "center",
    alignSelf: "center", marginBottom: 18,
  },
  title: {
    fontSize: 26, fontFamily: "Inter_700Bold", color: "#fff",
    textAlign: "center", marginBottom: 10, letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14, fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.5)", textAlign: "center",
    lineHeight: 21, marginBottom: 28,
  },
  subtitleEmphasis: { color: "rgba(255,255,255,0.85)", fontFamily: "Inter_600SemiBold" },
  form: {},
  label: {
    fontSize: 10, fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.4)", letterSpacing: 1.2, marginBottom: 8,
  },
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
  errorText: {
    flex: 1, fontSize: 13, fontFamily: "Inter_400Regular",
    color: "#f87171", lineHeight: 18,
  },
  submitBtnOuter: { borderRadius: 14, overflow: "hidden" },
  submitBtn: {
    height: 54, alignItems: "center", justifyContent: "center",
    flexDirection: "row", gap: 10,
  },
  submitText: {
    color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold", letterSpacing: 0.2,
  },
  resendBtn: { alignItems: "center", paddingVertical: 18 },
  resendText: {
    fontSize: 13, fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.45)", textDecorationLine: "underline",
  },
});
