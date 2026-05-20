/**
 * +not-found.tsx — Expo Router catch-all for unmatched routes.
 *
 * PRODUCTION POLICY: This screen must NEVER be visible to end users.
 *
 * On cold start (fresh Play Store install, deep link with an unrecognised
 * path, Play Store referral URL, etc.) Expo Router may route here before the
 * app has had a chance to resolve the correct initial screen.  We therefore:
 *
 *   1. Redirect to /(tabs)/channels immediately on mount (synchronous replace
 *      queued in a useEffect that fires before the first paint is committed).
 *   2. Show a branded splash-like loading indicator so that even in the
 *      unlikely event that the redirect takes a frame or two, the user sees
 *      the Temple TV brand — not a raw "404" error screen.
 *   3. Never render any text that says "404", "not found", or "error".
 *
 * Deep-link edge cases handled here:
 *   • /api/*, /admin/* — server paths that should never open the app
 *   • Unknown path segment from a Play Store referral or web share
 *   • OTA update channel mismatch on first launch (Expo handles this but the
 *     fallback still lands here if the router can't resolve the initial URL)
 */

import React, { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { router, Stack } from "expo-router";

export default function NotFoundScreen() {
  useEffect(() => {
    // Replace immediately — this runs before the first committed paint on
    // most devices, so users never see this screen at all.
    router.replace("/(tabs)/channels");
  }, []);

  // Render a minimal branded loading indicator in case the redirect takes
  // more than one frame (e.g. slow JS thread on low-end Android devices).
  return (
    <>
      <Stack.Screen options={{ headerShown: false, animation: "none" }} />
      <View style={styles.root}>
        <ActivityIndicator size="large" color="#6A0DAD" />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F8F5FF",
  },
});
