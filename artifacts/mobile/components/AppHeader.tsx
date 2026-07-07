import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";

type FeatherIconName = React.ComponentProps<typeof Feather>["name"];

export interface AppHeaderProps {
  /**
   * "tab"   — Large bold page title on the left, optional trailing action on the right.
   *           Use on the five main tab screens (Library, Channels, Radio, Settings).
   *           The Watch/Live screen is fully immersive — use no header there.
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
   * Trailing icon button (stack or tab variant).
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

  /**
   * Arbitrary leading element for the tab variant.
   * Rendered to the left of the title. In the stack variant the back button
   * always occupies the leading slot — this prop is ignored there.
   */
  left?: React.ReactNode;

  /** Omit the bottom hairline border. */
  borderless?: boolean;

  /** Override the header background colour (defaults to theme `background`). */
  backgroundColor?: string;
}

/**
 * Unified navigation header for the Temple TV mobile app.
 *
 * Variant "tab"   — Tab-bar screens: large bold page title left, optional
 *                   action right. No logo — the app icon already establishes
 *                   the brand; repeating the wordmark on every screen is
 *                   redundant and competes with content.
 * Variant "stack" — Stack screens: back arrow left, centred title,
 *                   optional trailing action right.
 *
 * Safe-area top inset is handled internally; callers must NOT add extra
 * paddingTop. The component does NOT render <Stack.Screen> — each screen
 * keeps its own `<Stack.Screen options={{ headerShown: false }}>` so route
 * metadata can still be customised per screen.
 *
 * Usage — tab screen:
 *   <AppHeader variant="tab" title="Library" />
 *
 * Usage — tab screen with trailing action:
 *   <AppHeader variant="tab" title="Library" rightIcon={{ name: "search", ... }} />
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
  left,
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
        // Large bold page title — clean, modern, lets content breathe.
        // No logo: the app icon + splash screen establish the brand; repeating
        // the wordmark on every tab header is visual noise that competes with
        // the content hierarchy.
        <>
          {left != null && <View style={styles.tabLeading}>{left}</View>}
          <Text
            style={[styles.tabTitle, { color: c.foreground }]}
            numberOfLines={1}
            accessibilityRole="header"
          >
            {title}
          </Text>
          {trailing != null && (
            <View style={styles.tabTrailing}>{trailing}</View>
          )}
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
  // Large, prominent page title — left-aligned like a modern streaming app.
  // Font weight 800 creates clear hierarchy: screen title > section headers > body.
  tabTitle: {
    flex: 1,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
    textAlign: "left",
  },
  tabLeading: {
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginRight: 8,
  },
  tabTrailing: {
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
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
