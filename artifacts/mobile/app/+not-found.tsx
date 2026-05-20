import { router, Stack } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

export default function NotFoundScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();

  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/channels");
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={[
          styles.container,
          {
            backgroundColor: c.background,
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <View style={styles.content}>
          <View style={[styles.iconWrap, { backgroundColor: c.primary + "1A" }]}>
            <Feather name="compass" size={40} color={c.primary} />
          </View>

          <Text style={[styles.code, { color: c.primary }]}>404</Text>
          <Text style={[styles.title, { color: c.foreground }]}>Page not found</Text>
          <Text style={[styles.description, { color: c.foreground }]}>
            This screen doesn&apos;t exist. You may have followed a broken link or typed the
            address incorrectly.
          </Text>

          <Pressable
            onPress={handleBack}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: c.primary, opacity: pressed ? 0.82 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="arrow-left" size={18} color="#fff" />
            <Text style={styles.primaryBtnText}>Go Back</Text>
          </Pressable>

          <Pressable
            onPress={() => router.replace("/(tabs)/channels")}
            style={({ pressed }) => [
              styles.secondaryBtn,
              { borderColor: c.border, opacity: pressed ? 0.7 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Go to home"
          >
            <Feather name="home" size={16} color={c.foreground} />
            <Text style={[styles.secondaryBtnText, { color: c.foreground }]}>Go to Home</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    alignItems: "center",
    paddingHorizontal: 32,
    maxWidth: 400,
    width: "100%",
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  code: {
    fontSize: 72,
    fontWeight: "900",
    lineHeight: 84,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 12,
  },
  description: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 36,
    opacity: 0.55,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    marginBottom: 12,
    minWidth: 180,
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 180,
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontSize: 15,
    fontWeight: "500",
  },
});
