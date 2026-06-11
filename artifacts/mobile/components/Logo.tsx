import React from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

/**
 * Single source of truth for the Temple TV brand mark inside the mobile
 * (Expo / React Native) app.
 *
 * Uses `logo.png` (900×600, RGBA — transparent background, 1.5:1 ratio)
 * so the brand mark renders cleanly over any background without a coloured
 * square behind it. Previously pointed to `icon.png` (1024×1024, RGB —
 * opaque dark background), which was the app-store icon and not suitable
 * for in-app display.
 *
 * Size presets (`"sm" | "md" | "lg" | "hero"`) drive the *height*; width
 * is derived from the 1.5:1 native aspect ratio so the mark never stretches
 * regardless of which surface renders it.
 */

type LogoSize = "sm" | "md" | "lg" | "hero";

// logo.png is 900×600 → 1.5:1 (width:height)
const ASPECT = 1.5;

const HEIGHT_PX: Record<LogoSize, number> = {
  sm: 24,
  md: 36,
  lg: 52,
  hero: 72,
};

interface LogoProps {
  size?: LogoSize;
  decorative?: boolean;
  style?: StyleProp<ImageStyle>;
}

export function Logo({
  size = "md",
  decorative = false,
  style,
}: LogoProps) {
  const height = HEIGHT_PX[size];
  const width = Math.round(height * ASPECT);

  return (
    <Image
      source={require("@/assets/images/logo.png")}
      resizeMode="contain"
      style={[{ width, height }, style]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : "image"}
      accessibilityLabel={decorative ? undefined : "Temple TV"}
      accessibilityIgnoresInvertColors
    />
  );
}
