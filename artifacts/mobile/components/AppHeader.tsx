import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { Logo } from "@/components/Logo";

interface AppHeaderProps {
  right?: React.ReactNode;
}

/**
 * Shared top-bar rendered on every tab screen.
 *
 * Handles safe-area top inset so each screen doesn't duplicate that
 * logic. Logo is always left-aligned (brand anchor); an optional
 * `right` slot accepts a single action (search button, icon, etc.).
 */
export function AppHeader({ right }: AppHeaderProps) {
  const insets = useSafeAreaInsets();
  const colors = useColors();

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + 8,
          backgroundColor: colors.background,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <Logo size="md" />
      <View style={styles.right}>{right ?? null}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  right: {
    minWidth: 32,
    alignItems: "flex-end",
  },
});
