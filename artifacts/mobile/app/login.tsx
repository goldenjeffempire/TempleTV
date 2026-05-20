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
  View,
  ActivityIndicator,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/AuthContext";
import { apiLogin } from "@/services/authApi";
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
  keyboardType?: any;
  autoCapitalize?: any;
  autoComplete?: any;
  returnKeyType?: any;
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
    title: "Sign In | Temple TV",
    description: "Sign in to your Temple TV account to continue watching where you left off.",
    path: "/login",
    noindex: true,
  });

  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.96, duration: 80, useNativeDriver: true }),
      Animated.timing(btnScale, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();

    setLoading(true);
    try {
      const resp = await apiLogin(trimmedEmail, password);
      await signIn(resp, resp.user);
      router.replace("/(tabs)/channels");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid credentials. Please try again.");
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
      <View style={[styles.accentBlur, { bottom: 80, left: -100, opacity: 0.4 }]} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
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
            onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)/channels")}
            style={[styles.backBtn, { top: insets.top + 8 }]}
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
              <Logo style={styles.logo} />
              <View style={styles.dividerLine} />
            </View>

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
                  <Pressable onPress={() => setShowPassword((p) => !p)} style={styles.eyeBtn} hitSlop={8}>
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
                  style={({ pressed }) => [styles.submitBtnOuter, { opacity: pressed ? 0.88 : 1 }]}
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
              onPress={() => Linking.openURL("mailto:support@templetv.org.ng?subject=Password%20Reset%20Request")}
              style={styles.forgotBtn}
              hitSlop={8}
            >
              <Text style={styles.forgotText}>Forgot password? Contact support</Text>
            </Pressable>

            <View style={styles.divider}>
              <View style={styles.dividerRule} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerRule} />
            </View>

            <Pressable
              onPress={() => router.replace("/signup")}
              style={({ pressed }) => [styles.signupBtn, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.signupText}>
                Don't have an account?{" "}
                <Text style={styles.signupLink}>Create one free</Text>
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
  logoWrap: { alignItems: "center", marginTop: 52, marginBottom: 32 },
  logo: { width: 130, height: 56, marginBottom: 20 },
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
