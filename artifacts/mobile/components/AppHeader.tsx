import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";

type FeatherIconName = React.ComponentProps<typeof Feather>["name"];

export interface AppHeaderProps {
  /**
   * "tab"   — Temple TV logo on the left, page title on the right.
   *           Use on the five main tab screens.
   * "stack" — Back arrow on the left, centred title, optional trailing action.
   *           Use on every secondary / push screen.
   * Defaults to "stack".
   */
  variant?: "tab" | "stack";

  /** Screen title displayed in the header. */
  title: string;

  /**
   * Stack variant only — override the back action.
   * Defaults to `router.back()` when omitted.
   */
  onBack?: () => void;

  /**
   * Trailing icon button (stack variant).
   * Renders a 44 × 44 Feather icon button at the trailing edge.
   */
  rightIcon?: {
    name: FeatherIconName;
    onPress: () => void;
    accessibilityLabel: string;
  };

  /**
   * Trailing text button (stack variant), e.g. "Clear All" or "Save".
   * Takes priority over rightIcon when both are provided.
   */
  rightLabel?: {
    text: string;
    onPress: () => void;
    accessibilityLabel?: string;
    /** Defaults to the theme primary colour. */
    color?: string;
  };

  /**
   * Arbitrary trailing element — takes priority over rightIcon and rightLabel.
   * Use when the trailing content doesn't fit the icon/label patterns above.
   */
  rightElement?: React.ReactNode;

  /** Omit the bottom hairline border. */
  borderless?: boolean;

  /** Override the header background colour (defaults to theme `background`). */
  backgroundColor?: string;
}

/**
 * Unified navigation header for the Temple TV mobile app.
 *
 * Variant "tab"   — Tab-bar screens: logo left, title right.
 * Variant "stack" — Stack screens:   back arrow left, centred title,
 *                                    optional trailing action right.
 *
 * Safe-area top inset is handled internally; callers must NOT add extra
 * paddingTop. The component does NOT render <Stack.Screen> — each screen
 * keeps its own `<Stack.Screen options={{ headerShown: false }}>` so route
 * metadata can still be customised per screen.
 *
 * Usage — tab screen:
 *   <AppHeader variant="tab" title="Library" />
 *
 * Usage — stack screen (simple):
 *   <AppHeader title="Playlists" />
 *
 * Usage — stack screen with trailing action:
 *   <AppHeader title="Watch History" rightLabel={{ text: "Clear All", onPress: handleClear }} />
 */
export function AppHeader({
  variant = "stack",
  title,
  onBack,
  rightIcon,
  rightLabel,
  rightElement,
  borderless = false,
  backgroundColor,
}: AppHeaderProps) {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const bg = backgroundColor ?? c.background;

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  // Resolve trailing content: rightElement > rightLabel > rightIcon > null
  let trailing: React.ReactNode = null;
  if (rightElement !== undefined) {
    trailing = rightElement;
  } else if (rightLabel) {
    trailing = (
      <Pressable
        onPress={rightLabel.onPress}
        hitSlop={8}
        style={styles.trailingPressable}
        accessibilityRole="button"
        accessibilityLabel={rightLabel.accessibilityLabel ?? rightLabel.text}
      >
        <Text style={[styles.trailingLabelText, { color: rightLabel.color ?? c.primary }]}>
          {rightLabel.text}
        </Text>
      </Pressable>
    );
  } else if (rightIcon) {
    trailing = (
      <Pressable
        onPress={rightIcon.onPress}
        hitSlop={8}
        style={styles.trailingPressable}
        accessibilityRole="button"
        accessibilityLabel={rightIcon.accessibilityLabel}
      >
        <Feather name={rightIcon.name} size={22} color={c.foreground} />
      </Pressable>
    );
  }

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + 6,
          backgroundColor: bg,
          borderBottomWidth: borderless ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: borderless ? "transparent" : c.border,
        },
      ]}
      accessibilityRole="header"
    >
      {variant === "tab" ? (
        // ── Tab variant ──────────────────────────────────────────────────────
        <>
          <Image
            source={require("@/assets/images/temple-tv-logo-full.png")}
            style={styles.logo}
            resizeMode="contain"
            accessible
            accessibilityLabel="Temple TV"
          />
          <Text
            style={[styles.tabTitle, { color: c.foreground }]}
            numberOfLines={1}
            accessibilityRole="text"
          >
            {title}
          </Text>
        </>
      ) : (
        // ── Stack variant ────────────────────────────────────────────────────
        <>
          {/* Leading: back button — always 40 × 40 touch target */}
          <Pressable
            onPress={handleBack}
            style={styles.leadingBtn}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="arrow-left" size={22} color={c.foreground} />
          </Pressable>

          {/* Centre: title — grows between leading/trailing, centred within its space */}
          <Text
            style={[styles.stackTitle, { color: c.foreground }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.82}
          >
            {title}
          </Text>

          {/* Trailing slot — 40 px spacer when empty so the title stays centred;
              widens naturally when content is present */}
          <View style={[styles.trailingSlot, trailing == null && styles.trailingSpacer]}>
            {trailing}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },

  // ── Tab variant ─────────────────────────────────────────────────────────────
  logo: {
    height: 38,
    width: 110,
    flexShrink: 0,
  },
  tabTitle: {
    flex: 1,
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: -0.4,
    textAlign: "right",
  },

  // ── Stack variant ───────────────────────────────────────────────────────────
  leadingBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stackTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: -0.3,
    textAlign: "center",
  },
  trailingSlot: {
    minWidth: 40,
    height: 40,
    alignItems: "flex-end",
    justifyContent: "center",
    flexShrink: 0,
  },
  trailingSpacer: {
    width: 40,
  },
  trailingPressable: {
    minWidth: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  trailingLabelText: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
});
