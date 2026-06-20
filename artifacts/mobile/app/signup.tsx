import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useRef, useState, useEffect } from "react";
import {
  Animated,
  KeyboardAvoidingView,
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
import { apiSignup, isValidEmail, validatePasswordStrength } from "@/services/authApi";
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

export default function SignupScreen() {
  usePageSeo({
    title: "Create Account",
    description: "Create a free account to save sermons, sync progress, and receive live notifications.",
    path: "/signup",
    noindex: true,
  });

  const insets = useSafeAreaInsets();
  const { signIn, consumePendingPlayback } = useAuth();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(32)).current;
  const btnScale = useRef(new Animated.Value(1)).current;

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 520, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, tension: 70, friction: 12, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleSignup = async () => {
    const trimmedName = displayName.trim();
    const trimmedEmail = email.trim().toLowerCase();
    setError(null);

    if (!trimmedName || !trimmedEmail || !password) {
      setError("Please fill in all required fields.");
      return;
    }
    if (trimmedName.length > 80) {
      setError("Display name must be 80 characters or fewer.");
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      setError("That doesn't look like a valid email address.");
      return;
    }
    const weak = validatePasswordStrength(password);
    if (weak) {
      setError(weak);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match. Please try again.");
      return;
    }

    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.96, duration: 80, useNativeDriver: true }),
      Animated.timing(btnScale, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();

    setLoading(true);
    try {
      const resp = await apiSignup(trimmedEmail, password, trimmedName);
      await signIn(resp, resp.user);
      // Guard: the user may have swiped back while the network call was in
      // flight. Calling router.replace() on an unmounted screen causes a
      // stale navigation push that can corrupt the navigator stack.
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
        setError(err instanceof Error ? err.message : "Sign up failed. Please try again.");
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
            hitSlop={8}
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

            <Text style={styles.title}>Create Account</Text>
            <Text style={styles.subtitle}>
              Free access to live worship, sermons, and 24/7 broadcasting — synced across all your devices.
            </Text>

            <View style={styles.form}>
              <Text style={styles.label}>YOUR NAME</Text>
              <AnimatedInput
                icon="user"
                placeholder="e.g. John Adeyemi"
                value={displayName}
                onChangeText={setDisplayName}
                autoCapitalize="words"
                returnKeyType="next"
              />

              <Text style={[styles.label, { marginTop: 16 }]}>EMAIL ADDRESS</Text>
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
                placeholder="At least 8 characters"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                returnKeyType="next"
                rightElement={
                  <Pressable onPress={() => setShowPassword((p) => !p)} style={styles.eyeBtn} hitSlop={8}>
                    <Feather
                      name={showPassword ? "eye-off" : "eye"}
                      size={17}
                      color="rgba(255,255,255,0.35)"
                    />
                  </Pressable>
                }
              />

              <Text style={[styles.label, { marginTop: 16 }]}>CONFIRM PASSWORD</Text>
              <AnimatedInput
                icon="shield"
                placeholder="Repeat your password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showConfirmPassword}
                returnKeyType="done"
                onSubmitEditing={handleSignup}
                rightElement={
                  <Pressable onPress={() => setShowConfirmPassword((p) => !p)} style={styles.eyeBtn} hitSlop={8}>
                    <Feather
                      name={showConfirmPassword ? "eye-off" : "eye"}
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
                  onPress={handleSignup}
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
                        <Feather name="user-plus" size={16} color="#FFF" />
                        <Text style={styles.submitText}>Create Account</Text>
                      </>
                    )}
                  </LinearGradient>
                </Pressable>
              </Animated.View>

              <Text style={styles.termsText}>
                By creating an account you agree to our Terms of Service and Privacy Policy.
              </Text>
            </View>

            <View style={styles.divider}>
              <View style={styles.dividerRule} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerRule} />
            </View>

            <Pressable
              onPress={() => router.replace("/login")}
              style={({ pressed }: { pressed: boolean }) => [styles.loginBtn, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.loginText}>
                Already have an account?{" "}
                <Text style={styles.loginLink}>Sign in</Text>
              </Text>
            </Pressable>
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
  logoWrap: { alignItems: "center", marginTop: 52, marginBottom: 28 },
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
    marginBottom: 32,
  },
  form: { gap: 0 },
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
  termsText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.2)",
    textAlign: "center",
    marginTop: 14,
    lineHeight: 16,
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 20,
  },
  dividerRule: { flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.08)" },
  dividerText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.25)",
  },
  loginBtn: { alignItems: "center", paddingVertical: 8 },
  loginText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.4)",
  },
  loginLink: {
    fontFamily: "Inter_600SemiBold",
    color: "#a78bfa",
  },
});
