import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useRef, useState, useEffect } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  ActivityIndicator,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/AuthContext";
import { apiLogin, apiLoginVerifyMfa, isValidEmail, MfaRequiredError } from "@/services/authApi";
import { Logo } from "@/components/Logo";
import { usePageSeo } from "@/hooks/usePageSeo";

function AnimatedInput({
  icon,
  placeholder,
  value,
  onChangeText,
  secureTextEntry,
  rightElement,
  keyboardType,
  autoCapitalize,
  autoComplete,
  returnKeyType,
  onSubmitEditing,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  placeholder: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  rightElement?: React.ReactNode;
  keyboardType?: TextInputProps["keyboardType"];
  autoCapitalize?: TextInputProps["autoCapitalize"];
  autoComplete?: TextInputProps["autoComplete"];
  returnKeyType?: TextInputProps["returnKeyType"];
  onSubmitEditing?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(glowAnim, {
      toValue: focused ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [focused]);

  const borderColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(255,255,255,0.12)", "rgba(139,92,246,0.8)"],
  });

  const bgColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(255,255,255,0.06)", "rgba(139,92,246,0.1)"],
  });

  return (
    <Animated.View
      style={[
        styles.inputRow,
        { borderColor, backgroundColor: bgColor },
      ]}
    >
      <Feather
        name={icon}
        size={17}
        color={focused ? "#a78bfa" : "rgba(255,255,255,0.35)"}
        style={styles.inputIcon}
      />
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.25)"
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize ?? "none"}
        autoComplete={autoComplete}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {rightElement}
    </Animated.View>
  );
}

export default function LoginScreen() {
  usePageSeo({
    title: "Sign In",
    description: "Sign in to your account to continue watching where you left off.",
    path: "/login",
    noindex: true,
  });

  const insets = useSafeAreaInsets();
  const { signIn, consumePendingPlayback } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // MFA challenge phase — set when the server returns mfaRequired: true.
  const [phase, setPhase] = useState<"credentials" | "mfa">("credentials");
  const mfaTokenRef = useRef<string>("");
  const [totpCode, setTotpCode] = useState("");

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(32)).current;
  const btnScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 520, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, tension: 70, friction: 12, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleLogin = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    setError(null);
    if (!trimmedEmail || !password) {
      setError("Please enter your email and password.");
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      setError("That doesn't look like a valid email address.");
      return;
    }

    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.96, duration: 80, useNativeDriver: true }),
      Animated.timing(btnScale, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();

    setLoading(true);
    try {
      const resp = await apiLogin(trimmedEmail, password);
      await signIn(resp, resp.user);
      // Guard: the user may have swiped back while the network call was in
      // flight. Calling router.replace() on an unmounted screen causes a
      // stale navigation push that can corrupt the navigator stack.
      if (!mountedRef.current) return;
      // If the user was gated into login while trying to play something,
      // restore that target instead of dumping them on the home tab.
      const pending = consumePendingPlayback();
      if (pending?.pathname) {
        router.replace({ pathname: pending.pathname, params: pending.params } as never);
      } else {
        router.replace("/(tabs)");
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof MfaRequiredError) {
        // Server returned mfaRequired — switch to the TOTP challenge phase.
        mfaTokenRef.current = err.mfaToken;
        setTotpCode("");
        setError(null);
        setPhase("mfa");
      } else if (err instanceof Error && /network|timed?\s*out|fetch/i.test(err.message)) {
        setError("Couldn't reach the server. Check your connection and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const handleMfaSubmit = async () => {
    const code = totpCode.replace(/\D/g, "").trim();
    setError(null);
    if (code.length !== 6) {
      setError("Please enter the 6-digit code from your authenticator app.");
      return;
    }

    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.96, duration: 80, useNativeDriver: true }),
      Animated.timing(btnScale, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();

    setLoading(true);
    try {
      const resp = await apiLoginVerifyMfa(mfaTokenRef.current, code);
      await signIn(resp, resp.user);
      if (!mountedRef.current) return;
      const pending = consumePendingPlayback();
      if (pending?.pathname) {
        router.replace({ pathname: pending.pathname, params: pending.params } as never);
      } else {
        router.replace("/(tabs)");
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof Error && /network|timed?\s*out|fetch/i.test(err.message)) {
        setError("Couldn't reach the server. Check your connection and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Verification failed. Please try again.");
      }
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
      <View style={[styles.accentBlur, { bottom: 80, left: -100, opacity: 0.4 }]} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 48 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)")}
            style={[styles.backBtn, { top: insets.top + 8 }]}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <View style={styles.backBtnInner}>
              <Feather name="x" size={18} color="rgba(255,255,255,0.7)" />
            </View>
          </Pressable>

          <Animated.View
            style={[
              styles.content,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            <View style={styles.logoWrap}>
              <Logo size="lg" style={{ marginBottom: 20 }} />
              <View style={styles.dividerLine} />
            </View>

            {phase === "credentials" ? (
              <>
                <Text style={styles.title}>Welcome back</Text>
                <Text style={styles.subtitle}>
                  Sign in to sync your favourites and watch history across devices.
                </Text>

                <View style={styles.form}>
                  <Text style={styles.label}>EMAIL ADDRESS</Text>
                  <AnimatedInput
                    icon="mail"
                    placeholder="you@example.com"
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    returnKeyType="next"
                  />

                  <Text style={[styles.label, { marginTop: 16 }]}>PASSWORD</Text>
                  <AnimatedInput
                    icon="lock"
                    placeholder="Your password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    autoComplete="password"
                    returnKeyType="done"
                    onSubmitEditing={handleLogin}
                    rightElement={
                      <Pressable onPress={() => setShowPassword((p) => !p)} style={styles.eyeBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={showPassword ? "Hide password" : "Show password"}>
                        <Feather
                          name={showPassword ? "eye-off" : "eye"}
                          size={17}
                          color="rgba(255,255,255,0.35)"
                        />
                      </Pressable>
                    }
                  />

                  {error && (
                    <View style={styles.errorBox}>
                      <Feather name="alert-circle" size={14} color="#f87171" />
                      <Text style={styles.errorText}>{error}</Text>
                    </View>
                  )}

                  <Animated.View style={[{ transform: [{ scale: btnScale }] }, { marginTop: 28 }]}>
                    <Pressable
                      onPress={handleLogin}
                      disabled={loading}
                      style={({ pressed }: { pressed: boolean }) => [styles.submitBtnOuter, { opacity: pressed ? 0.88 : 1 }]}
                    >
                      <LinearGradient
                        colors={["#7c3aed", "#6d28d9", "#5b21b6"]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.submitBtn}
                      >
                        {loading ? (
                          <ActivityIndicator color="#FFF" size="small" />
                        ) : (
                          <>
                            <Feather name="log-in" size={16} color="#FFF" />
                            <Text style={styles.submitText}>Sign In</Text>
                          </>
                        )}
                      </LinearGradient>
                    </Pressable>
                  </Animated.View>
                </View>

                <Pressable
                  onPress={() => router.push("/forgot-password" as never)}
                  style={styles.forgotBtn}
                  hitSlop={8}
                >
                  <Text style={styles.forgotText}>Forgot password?</Text>
                </Pressable>

                <View style={styles.divider}>
                  <View style={styles.dividerRule} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.dividerRule} />
                </View>

                <Pressable
                  onPress={() => router.replace("/signup")}
                  style={({ pressed }: { pressed: boolean }) => [styles.signupBtn, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text style={styles.signupText}>
                    Don't have an account?{" "}
                    <Text style={styles.signupLink}>Create one free</Text>
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.mfaIconWrap}>
                  <Feather name="shield" size={40} color="#a78bfa" />
                </View>
                <Text style={styles.title}>Two-Factor Auth</Text>
                <Text style={styles.subtitle}>
                  Enter the 6-digit code from your authenticator app to complete sign-in.
                </Text>

                <View style={styles.form}>
                  <Text style={styles.label}>VERIFICATION CODE</Text>
                  <AnimatedInput
                    icon="key"
                    placeholder="000000"
                    value={totpCode}
                    onChangeText={(v) => setTotpCode(v.replace(/\D/g, "").slice(0, 6))}
                    keyboardType="number-pad"
                    autoCapitalize="none"
                    returnKeyType="done"
                    onSubmitEditing={handleMfaSubmit}
                  />

                  {error && (
                    <View style={styles.errorBox}>
                      <Feather name="alert-circle" size={14} color="#f87171" />
                      <Text style={styles.errorText}>{error}</Text>
                    </View>
                  )}

                  <Animated.View style={[{ transform: [{ scale: btnScale }] }, { marginTop: 28 }]}>
                    <Pressable
                      onPress={handleMfaSubmit}
                      disabled={loading || totpCode.length < 6}
                      style={({ pressed }: { pressed: boolean }) => [styles.submitBtnOuter, { opacity: (pressed || totpCode.length < 6) ? 0.6 : 1 }]}
                    >
                      <LinearGradient
                        colors={["#7c3aed", "#6d28d9", "#5b21b6"]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.submitBtn}
                      >
                        {loading ? (
                          <ActivityIndicator color="#FFF" size="small" />
                        ) : (
                          <>
                            <Feather name="check-circle" size={16} color="#FFF" />
                            <Text style={styles.submitText}>Verify</Text>
                          </>
                        )}
                      </LinearGradient>
                    </Pressable>
                  </Animated.View>
                </View>

                <Pressable
                  onPress={() => { setPhase("credentials"); setError(null); setTotpCode(""); }}
                  style={styles.forgotBtn}
                  hitSlop={8}
                >
                  <Text style={styles.forgotText}>← Back to sign in</Text>
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
  backBtn: { position: "absolute", right: 16, zIndex: 10 },
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
  content: { flex: 1 },
  logoWrap: { alignItems: "center", marginTop: 52, marginBottom: 32 },
  dividerLine: {
    width: 48,
    height: 2,
    borderRadius: 1,
    backgroundColor: "rgba(139,92,246,0.5)",
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#ffffff",
    textAlign: "center",
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.45)",
    textAlign: "center",
    lineHeight: 21,
    marginBottom: 36,
  },
  form: { gap: 0 },
  mfaIconWrap: {
    alignSelf: "center",
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(139,92,246,0.15)",
    borderWidth: 1,
    borderColor: "rgba(139,92,246,0.35)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  label: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.35)",
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 54,
  },
  inputIcon: { marginRight: 10 },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#ffffff",
  },
  eyeBtn: { padding: 4 },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(239,68,68,0.1)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.25)",
    marginTop: 12,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#f87171",
    lineHeight: 18,
  },
  submitBtnOuter: { borderRadius: 14, overflow: "hidden" },
  submitBtn: {
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
  },
  submitText: {
    color: "#FFF",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.2,
  },
  forgotBtn: { alignItems: "center", paddingVertical: 16 },
  forgotText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.35)",
    textDecorationLine: "underline",
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 8,
  },
  dividerRule: { flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.08)" },
  dividerText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.25)",
  },
  signupBtn: { alignItems: "center", paddingVertical: 12 },
  signupText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.4)",
  },
  signupLink: {
    fontFamily: "Inter_600SemiBold",
    color: "#a78bfa",
  },
});
