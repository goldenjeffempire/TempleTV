import React from "react";
import { Image, Text, View, type StyleProp, type ViewStyle } from "react-native";

/**
 * Temple TV brand wordmark — bird icon + "Temple" + ".tv" in brand red.
 *
 * Used on auth screens (dark bg, white text by default) and the settings footer.
 * Pass `textColor` to match the host surface; ".tv" is always brand red (#E8002C).
 *
 * Size presets drive the icon and font size proportionally:
 *   sm → 20px icon / 14px text
 *   md → 28px icon / 20px text
 *   lg → 36px icon / 26px text  (used on auth screens)
 *   hero → 48px icon / 36px text
 */

type LogoSize = "sm" | "md" | "lg" | "hero";

const CONFIG: Record<LogoSize, { birdSize: number; fontSize: number }> = {
  sm:   { birdSize: 20, fontSize: 14 },
  md:   { birdSize: 28, fontSize: 20 },
  lg:   { birdSize: 36, fontSize: 26 },
  hero: { birdSize: 48, fontSize: 36 },
};

const BRAND_RED = "#E8002C";

interface LogoProps {
  size?: LogoSize;
  textColor?: string;
  decorative?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Logo({
  size = "md",
  textColor = "#ffffff",
  decorative = false,
  style,
}: LogoProps) {
  const { birdSize, fontSize } = CONFIG[size];

  return (
    <View
      style={[{ flexDirection: "row", alignItems: "center", gap: 6 }, style]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : "image"}
      accessibilityLabel={decorative ? undefined : "Temple TV"}
    >
      <Image
        source={require("@/assets/images/adaptive-icon-foreground.png")}
        style={{ width: birdSize, height: birdSize, tintColor: textColor }}
        resizeMode="contain"
        accessibilityElementsHidden
      />
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Text
          style={{
            fontSize,
            fontWeight: "700",
            letterSpacing: -0.5,
            color: textColor,
          }}
        >
          Temple
        </Text>
        <Text
          style={{
            fontSize,
            fontWeight: "700",
            letterSpacing: -0.5,
            color: BRAND_RED,
          }}
        >
          .tv
        </Text>
      </View>
    </View>
  );
}
