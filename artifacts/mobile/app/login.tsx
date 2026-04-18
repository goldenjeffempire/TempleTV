import React, { useState } from "react";
import {
  Alert,
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
  Image,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/context/AuthContext";
import { apiLogin } from "@/services/authApi";

export default function LoginScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      Alert.alert("Missing Fields", "Please enter your email and password.");
      return;
    }

    setLoading(true);
    try {
      const { token, user } = await apiLogin(trimmedEmail, password);
      await signIn(token, user);
      router.replace("/");
    } catch (err) {
      Alert.alert("Login Failed", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: c.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={() => router.back()}
          style={[styles.backBtn, { top: insets.top + 8 }]}
        >
          <Feather name="x" size={22} color={c.mutedForeground} />
        </Pressable>

        <Image
          source={require("@/assets/images/logo.png")}
          style={styles.logo}
          resizeMode="contain"
        />

        <Text style={[styles.title, { color: c.foreground }]}>Welcome back</Text>
        <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
          Sign in to sync your favourites and watch history across devices.
        </Text>

        <View style={styles.form}>
          <Text style={[styles.label, { color: c.mutedForeground }]}>Email address</Text>
          <View style={[styles.inputRow, { backgroundColor: c.secondary, borderColor: c.border }]}>
            <Feather name="mail" size={16} color={c.mutedForeground} style={styles.inputIcon} />
            <TextInput
              style={[styles.input, { color: c.foreground }]}
              placeholder="you@example.com"
              placeholderTextColor={c.mutedForeground}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              returnKeyType="next"
            />
          </View>

          <Text style={[styles.label, { color: c.mutedForeground }]}>Password</Text>
          <View style={[styles.inputRow, { backgroundColor: c.secondary, borderColor: c.border }]}>
            <Feather name="lock" size={16} color={c.mutedForeground} style={styles.inputIcon} />
            <TextInput
              style={[styles.input, { color: c.foreground }]}
              placeholder="Your password"
              placeholderTextColor={c.mutedForeground}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoComplete="password"
              returnKeyType="done"
              onSubmitEditing={handleLogin}
            />
            <Pressable onPress={() => setShowPassword((p) => !p)} style={styles.eyeBtn}>
              <Feather
                name={showPassword ? "eye-off" : "eye"}
                size={16}
                color={c.mutedForeground}
              />
            </Pressable>
          </View>

          <Pressable
            onPress={handleLogin}
            disabled={loading}
            style={({ pressed }) => [
              styles.submitBtn,
              { backgroundColor: c.primary, opacity: pressed || loading ? 0.8 : 1 },
            ]}
          >
            {loading ? (
              <ActivityIndicator color="#FFF" size="small" />
            ) : (
              <Text style={styles.submitText}>Sign in</Text>
            )}
          </Pressable>
        </View>

        <Pressable
          onPress={() => Linking.openURL("mailto:support@templetv.jctm?subject=Password%20Reset%20Request")}
          style={styles.forgotBtn}
        >
          <Text style={[styles.forgotText, { color: c.mutedForeground }]}>
            Forgot your password? Contact support
          </Text>
        </Pressable>

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: c.mutedForeground }]}>
            Don't have an account?{" "}
          </Text>
          <Pressable onPress={() => router.replace("/signup")}>
            <Text style={[styles.footerLink, { color: c.primary }]}>Create one</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24 },
  backBtn: { position: "absolute", right: 16, zIndex: 10, padding: 8 },
  logo: { width: 120, height: 60, alignSelf: "center", marginBottom: 24, marginTop: 48 },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", textAlign: "center", marginBottom: 8 },
  subtitle: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 32 },
  form: { gap: 6 },
  label: { fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, marginBottom: 4, marginTop: 12 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 50,
  },
  inputIcon: { marginRight: 8 },
  input: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular" },
  eyeBtn: { padding: 4 },
  submitBtn: {
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
  },
  submitText: { color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 16,
  },
  footerText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  footerLink: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  forgotBtn: {
    alignItems: "center",
    paddingVertical: 12,
    marginTop: 8,
  },
  forgotText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textDecorationLine: "underline",
  },
});
