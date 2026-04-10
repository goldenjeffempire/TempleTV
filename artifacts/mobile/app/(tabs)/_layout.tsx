import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { useColors } from "@/hooks/useColors";
import { MiniPlayer } from "@/components/MiniPlayer";

function NativeTabLayout() {
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
        <NativeTabs.Trigger name="radio">
          <Icon sf={{ default: "radio", selected: "radio.fill" }} />
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

function ClassicTabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.mutedForeground,
          headerShown: false,
          tabBarStyle: {
            position: "absolute",
            backgroundColor: isIOS ? "transparent" : "rgba(0,0,0,0.95)",
            borderTopWidth: 0,
            borderTopColor: colors.border,
            elevation: 0,
            ...(isWeb ? { height: 84 } : {}),
          },
          tabBarBackground: () =>
            isIOS ? (
              <BlurView
                intensity={100}
                tint="dark"
                style={StyleSheet.absoluteFill}
              />
            ) : isWeb ? (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    backgroundColor: "rgba(0,0,0,0.95)",
                    borderTopWidth: 1,
                    borderTopColor: "rgba(106,13,173,0.25)",
                  },
                ]}
              />
            ) : null,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Watch",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView name="tv" tintColor={color} size={24} />
              ) : (
                <Feather name="tv" size={22} color={color} />
              ),
          }}
        />
        <Tabs.Screen
          name="library"
          options={{
            title: "Library",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView name="books.vertical" tintColor={color} size={24} />
              ) : (
                <Feather name="book-open" size={22} color={color} />
              ),
          }}
        />
        <Tabs.Screen
          name="radio"
          options={{
            title: "Radio",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView name="radio" tintColor={color} size={24} />
              ) : (
                <Feather name="radio" size={22} color={color} />
              ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
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

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
