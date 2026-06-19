import React from "react";
import { Image, type StyleProp, type ImageStyle } from "react-native";

/**
 * Temple TV official logo image component.
 *
 * Renders the full Temple TV logo PNG (dove + wordmark) at the requested size.
 * The image is transparent-background so it works on any surface.
 *
 * Size presets (height in px — width scales automatically via aspectRatio):
 *   sm   → 28 px tall  (settings footer, compact spots)
 *   md   → 40 px tall  (auth sub-headers, cards)
 *   lg   → 56 px tall  (auth main header)
 *   hero → 80 px tall  (splash / onboarding)
 */

type LogoSize = "sm" | "md" | "lg" | "hero";

const HEIGHT: Record<LogoSize, number> = {
  sm:   28,
  md:   40,
  lg:   56,
  hero: 80,
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
  const height = HEIGHT[size];

  return (
    <Image
      source={require("@/assets/images/temple-tv-logo-full.png")}
      style={[{ height, width: height * 2.8 }, style]}
      resizeMode="contain"
      accessible={!decorative}
      accessibilityLabel={decorative ? undefined : "Temple TV"}
    />
  );
}
