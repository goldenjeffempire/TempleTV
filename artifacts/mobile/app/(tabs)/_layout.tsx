import { BlurView } from "expo-blur";
import { Tabs, router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React, { useLayoutEffect, useRef } from "react";
import {
  Platform,
  StyleSheet,
  View,
  useColorScheme,
} from "react-native";

// expo-glass-effect is iOS-only. Using a lazy require (not a static import)
// prevents its native module from initialising at startup on Android/web,
// where the module may not be linked and could throw at module-eval time.
function isGlassEffectAvailable(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("expo-glass-effect") as {
      isLiquidGlassAvailable?: () => boolean;
    };
    return typeof mod.isLiquidGlassAvailable === "function" && mod.isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

import { useColors } from "@/hooks/useColors";
import { MiniPlayer } from "@/components/MiniPlayer";

// ─── Native Tab Layout (iOS 18 + Liquid Glass) ────────────────────────────────
// NativeTabs does not expose initialRouteName; redirect on mount instead.
//
// IMPORTANT: expo-router/unstable-native-tabs is imported lazily via inline
// require() here, NOT via a top-level static import. This prevents the module
// initialization chain (which includes react-native-screens feature flag
// mutations and NativeBottomTabs navigator setup) from executing at app startup
// on Android/web — where this layout is never rendered and where the module
// chain would cause a hard crash in release builds with ProGuard enabled.
// On iOS 18+ (the only platform where isLiquidGlassAvailable() returns true),
// the require() call is deferred to first render so all native modules are
// fully initialized before this code runs.
//
// The `hasRedirectedRef` guard ensures the redirect fires exactly once across
// the layout's lifetime. Without it, any internal remount (e.g. hot reload or
// a React StrictMode double-invoke in dev) could reset the active tab to
// /channels, overriding the user's current navigation state.
function NativeTabLayout() {
  const hasRedirectedRef = useRef(false);

  useLayoutEffect(() => {
    if (hasRedirectedRef.current) return;
    hasRedirectedRef.current = true;
    router.replace("/channels");
  }, []);

  // Lazy require — only runs on iOS 18+ when this component is rendered.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NativeTabs, Icon, Label } = require("expo-router/unstable-native-tabs") as {
    NativeTabs: any;
    Icon: React.ComponentType<any>;
    Label: React.ComponentType<any>;
  };

  return (
    <>
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <Icon sf={{ default: "tv", selected: "tv.fill" }} />
          <Label>Watch</Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="library">
          <Icon sf={{ default: "books.vertical", selected: "books.vertical.fill" }} />
          <Label>Library</Label>
        </NativeTabs.Trigger>

        {/* CENTER — Channels is the primary hub */}
        <NativeTabs.Trigger name="channels">
          <Icon
            sf={{
              default: "square.grid.2x2.fill",
              selected: "square.grid.2x2.fill",
            }}
          />
          <Label>Channel</Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="radio">
          <Icon
            sf={{
              default: "antenna.radiowaves.left.and.right",
              selected: "antenna.radiowaves.left.and.right",
            }}
          />
          <Label>Radio</Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="settings">
          <Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
          <Label>Settings</Label>
        </NativeTabs.Trigger>
      </NativeTabs>
      <MiniPlayer />
    </>
  );
}

// ─── Classic Tab Layout (Android / web / older iOS) ───────────────────────────
function ClassicTabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Tabs
        initialRouteName="channels"
        screenOptions={{
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.mutedForeground,
          headerShown: false,
          tabBarStyle: {
            position: "absolute",
            backgroundColor: isIOS ? "transparent" : colors.surfaceGlass,
            borderTopWidth: 0,
            elevation: 0,
            ...(isWeb ? { height: 84 } : {}),
          },
          tabBarBackground: () =>
            isIOS ? (
              <BlurView
                intensity={85}
                tint={isDark ? "dark" : "light"}
                style={StyleSheet.absoluteFill}
              />
            ) : isWeb ? (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    backgroundColor: colors.surfaceGlass,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.border,
                  },
                ]}
              />
            ) : null,
        }}
      >
        {/* ── Watch ─────────────────────────────────────────────────────── */}
        <Tabs.Screen
          name="index"
          options={{
            headerShown: false,
            title: "Watch",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView name="tv" tintColor={color} size={24} />
              ) : (
                <Feather name="tv" size={22} color={color} />
              ),
          }}
        />

        {/* ── Library ───────────────────────────────────────────────────── */}
        <Tabs.Screen
          name="library"
          options={{
            headerShown: false,
            title: "Library",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView
                  name="books.vertical"
                  tintColor={color}
                  size={24}
                />
              ) : (
                <Feather name="book-open" size={22} color={color} />
              ),
          }}
        />

        {/* ── Channels (CENTER HUB) ──────────────────────────────────────── */}
        <Tabs.Screen
          name="channels"
          options={{
            headerShown: false,
            title: "Channel",
            tabBarLabel: "",
            tabBarItemStyle: { paddingTop: 0 },
            tabBarIcon: ({ focused }) => (
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: focused ? colors.primary : colors.muted,
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: -20,
                  shadowColor: colors.primary,
                  shadowOpacity: focused ? 0.5 : 0,
                  shadowRadius: 12,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: focused ? 10 : 0,
                }}
              >
                {isIOS ? (
                  <SymbolView
                    name="square.grid.2x2.fill"
                    tintColor={focused ? "#fff" : colors.mutedForeground}
                    size={26}
                  />
                ) : (
                  <Feather
                    name="grid"
                    size={26}
                    color={focused ? "#fff" : colors.mutedForeground}
                  />
                )}
              </View>
            ),
          }}
        />

        {/* ── Radio ─────────────────────────────────────────────────────── */}
        <Tabs.Screen
          name="radio"
          options={{
            headerShown: false,
            title: "Radio",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView
                  name="antenna.radiowaves.left.and.right"
                  tintColor={color}
                  size={24}
                />
              ) : (
                <Feather name="radio" size={22} color={color} />
              ),
          }}
        />

        {/* ── Settings ──────────────────────────────────────────────────── */}
        <Tabs.Screen
          name="settings"
          options={{
            headerShown: false,
            title: "Settings",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView name="gearshape" tintColor={color} size={24} />
              ) : (
                <Feather name="settings" size={22} color={color} />
              ),
          }}
        />
      </Tabs>

      <MiniPlayer />
    </View>
  );
}

// ─── Root export ──────────────────────────────────────────────────────────────
export default function TabLayout() {
  if (isGlassEffectAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
