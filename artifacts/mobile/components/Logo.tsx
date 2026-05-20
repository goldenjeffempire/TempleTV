import React from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

/**
 * Single source of truth for the Temple TV brand mark inside the mobile
 * (Expo / React Native) app.
 *
 * Replaces the previous pattern of six duplicated inline
 * `<Image source={require("@/assets/images/logo.png")} ... />` call sites
 * (login, signup, settings, two on the home tab, and the auth-gate
 * modal). Inlining the require was fine functionally, but every surface
 * picked its own `width`/`height`/`resizeMode` and there was no central
 * place to bump the asset, change the alt-text, or apply a global tweak
 * (e.g. switching to a hi-DPI variant). Now there is.
 *
 * Mobile-specific differences from the web variants:
 *
 *   - `Image.resolveAssetSource` already returns intrinsic width/height
 *     for the bundled `logo.png`, so React Native auto-reserves the
 *     layout box (no CLS to worry about — RN's layout engine doesn't
 *     reflow on bitmap arrival the way the DOM does).
 *
 *   - `accessibilityRole="image"` plus `accessibilityLabel` ensure
 *     VoiceOver / TalkBack announce "Temple TV, image" instead of
 *     skipping the asset entirely (RN images are inert by default).
 *     Decorative placements pass `decorative` to skip the announcement.
 *
 *   - Size **presets** (`"sm" | "md" | "lg" | "hero"`) instead of free-
 *     form pixels. Mobile screens vary wildly (small phone vs tablet vs
 *     foldable); fixed pixel sizes routinely look right on a Pixel 7 and
 *     wrong on an iPhone SE / iPad Pro. Presets force every call site to
 *     pick from the same vocabulary so the brand mark stays recognisable
 *     across devices.
 */

type LogoSize = "sm" | "md" | "lg" | "hero";
type LogoVariant = "icon" | "wordmark";

const SIZE_PX: Record<LogoSize, number> = {
  sm: 32,
  md: 48,
  lg: 72,
  hero: 96,
};

// Natural aspect of the bundled `logo.png` (900×600) — keeps the
// wordmark from squashing on devices with non-standard pixel ratios.
const ASPECT = 1.5;

interface LogoProps {
  size?: LogoSize;
  variant?: LogoVariant;
  decorative?: boolean;
  style?: StyleProp<ImageStyle>;
}

export function Logo({
  size = "md",
  variant = "wordmark",
  decorative = false,
  style,
}: LogoProps) {
  const px = SIZE_PX[size];
  const isWordmark = variant === "wordmark";
  const width = isWordmark ? Math.round(px * ASPECT) : px;
  const height = px;

  return (
    <Image
      source={require("@/assets/images/temple-tv-logo.png")}
      style={[{ width, height, resizeMode: "contain" }, style]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : "image"}
      accessibilityLabel={decorative ? undefined : "Temple TV"}
      accessibilityIgnoresInvertColors
    />
  );
}
