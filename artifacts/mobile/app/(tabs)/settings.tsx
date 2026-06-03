import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { AppHeader } from "@/components/AppHeader";
import { GlassCard } from "@/components/GlassCard";
import { Logo } from "@/components/Logo";
import { usePlayer } from "@/context/PlayerContext";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { useFavorites } from "@/hooks/useFavorites";
import { useNotificationPreferences } from "@/hooks/useNotificationPreferences";
import { useAuth } from "@/context/AuthContext";
import { useTheme, type ThemeChoice } from "@/context/ThemeContext";
import Constants from "expo-constants";
import { APP_CONFIG } from "@/constants/config";
import {
  requestNotificationPermissions,
  getNotificationPermissionStatus,
} from "@/services/notifications";

const APP_VERSION =
  Constants.expoConfig?.version ?? "1.0.5";

function ToggleSwitch({ value, onToggle, label }: { value: boolean; onToggle: () => void; label?: string }) {
  const c = useColors();
  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onToggle();
      }}
      style={[styles.switch, { backgroundColor: value ? c.primary : c.muted }]}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
    >
      <Animated.View style={[styles.thumb, { transform: [{ translateX: value ? 20 : 0 }] }]} />
    </Pressable>
  );
}

interface RowProps {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  description?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  danger?: boolean;
  value?: string;
}

function Row({ icon, label, description, onPress, right, danger, value }: RowProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: c.border },
        pressed && onPress ? { backgroundColor: c.muted + "40" } : {},
      ]}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={description ? `${label}. ${description}` : label}
    >
      <View
        style={[
          styles.rowIcon,
          { backgroundColor: danger ? "#ef444422" : c.primary + "22" },
        ]}
      >
        <Feather name={icon} size={16} color={danger ? "#ef4444" : c.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color: danger ? "#ef4444" : c.foreground }]}>
          {label}
        </Text>
        {description && (
          <Text style={[styles.rowDesc, { color: c.mutedForeground }]}>{description}</Text>
        )}
        {value && (
          <Text style={[styles.rowValue, { color: c.mutedForeground }]}>{value}</Text>
        )}
      </View>
      {right ?? (onPress && <Feather name="chevron-right" size={16} color={c.mutedForeground} />)}
    </Pressable>
  );
}

function SectionTitle({ title }: { title: string }) {
  const c = useColors();
  return (
    <Text style={[styles.sectionTitle, { color: c.mutedForeground }]}>{title}</Text>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { theme, setTheme } = useTheme();

  const { user, isLoggedIn, signOut } = useAuth();
  const { stopPlayback } = usePlayer();
  const { history, clearHistory } = useWatchHistory();
  const { favorites } = useFavorites();
  const {
    prefs: notifPrefs,
    save: saveNotifPrefs,
    hasSeenOptIn,
  } = useNotificationPreferences();

  const [notifGranted, setNotifGranted] = useState(false);

  // Web push state — only meaningful when Platform.OS === "web"
  const [webPushPermission, setWebPushPermission] = useState<NotificationPermission | null>(null);
  const [webPushBusy, setWebPushBusy] = useState(false);

  // True when running in a browser that supports W3C Web Push.
  // serviceWorker + PushManager + Notification is the correct feature triplet.
  const webPushSupported =
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  useEffect(() => {
    getNotificationPermissionStatus().then((status) => {
      if (Platform.OS !== "web") {
        setNotifGranted(status === "granted");
      } else {
        // On web, status is null when push is unsupported; otherwise the
        // browser's current Notification.permission value.
        setWebPushPermission(status);
      }
    });
  }, []);

  const handleToggleNotifs = useCallback(async () => {
    if (Platform.OS === "web") return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!notifGranted) {
      const granted = await requestNotificationPermissions();
      setNotifGranted(granted);
    }
  }, [notifGranted]);

  // Web-only: request permission → subscribe → register with server
  const handleWebPush = useCallback(async () => {
    if (webPushBusy) return;
    setWebPushBusy(true);
    try {
      const granted = await requestNotificationPermissions();
      // Re-read the real browser permission so the badge reflects the
      // outcome even if the user dismissed without allowing.
      const status = await getNotificationPermissionStatus();
      setWebPushPermission(status);
      if (!granted && status === "denied") {
        Alert.alert(
          "Notifications Blocked",
          "Push notifications are blocked in your browser. To enable them, click the lock icon in your address bar, allow notifications, then tap Enable again.",
          [{ text: "OK" }],
        );
      }
    } finally {
      setWebPushBusy(false);
    }
  }, [webPushBusy]);

  const handleLogout = useCallback(() => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          stopPlayback();
          await signOut();
        },
      },
    ]);
  }, [signOut, stopPlayback]);

  const handleClearHistory = useCallback(() => {
    Alert.alert("Clear Watch History", "This will remove all watched videos from your history.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: clearHistory,
      },
    ]);
  }, [clearHistory]);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <AppHeader />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        showsVerticalScrollIndicator={false}
      >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Settings</Text>
      </View>

      {/* Account */}
      <SectionTitle title="ACCOUNT" />
      <GlassCard style={styles.card}>
        {isLoggedIn && user ? (
          <>
            <Pressable
              onPress={() => router.push("/account")}
              style={({ pressed }) => [styles.profileRow, pressed && { opacity: 0.75 }]}
              accessibilityRole="button"
              accessibilityLabel="Edit profile"
            >
              <View style={[styles.avatar, { backgroundColor: c.primary }]}>
                <Text style={styles.avatarText}>
                  {(user.displayName ?? user.email)?.[0]?.toUpperCase() ?? "U"}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.profileName, { color: c.foreground }]}>
                  {user.displayName ?? "Signed In"}
                </Text>
                <Text style={[styles.profileEmail, { color: c.mutedForeground }]}>
                  {user.email}
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={c.mutedForeground} />
            </Pressable>
            <Row
              icon="user"
              label="Edit Profile"
              description="Update your display name"
              onPress={() => router.push("/account")}
            />
            <Row
              icon="lock"
              label="Change Password"
              onPress={() => router.push("/change-password")}
            />
            <Row
              icon="log-out"
              label="Sign Out"
              onPress={handleLogout}
              danger
            />
          </>
        ) : (
          <>
            <Row
              icon="log-in"
              label="Sign In"
              description="Access your watch history and favorites"
              onPress={() => router.push("/login")}
            />
            <Row
              icon="user-plus"
              label="Create Account"
              onPress={() => router.push("/signup")}
            />
          </>
        )}
      </GlassCard>

      {/* Notifications */}
      <SectionTitle title="NOTIFICATIONS" />
      <GlassCard style={styles.card}>
        {Platform.OS !== "web" ? (
          // ── Native (iOS / Android) ─────────────────────────────────────────
          <>
            <Row
              icon="bell"
              label="Push Notifications"
              description={notifGranted ? "Enabled" : "Tap to enable"}
              onPress={notifGranted ? undefined : handleToggleNotifs}
              right={
                <View style={[styles.badge, { backgroundColor: notifGranted ? "#22c55e22" : c.muted }]}>
                  <Text style={{ fontSize: 11, color: notifGranted ? "#22c55e" : c.mutedForeground, fontWeight: "600" }}>
                    {notifGranted ? "ON" : "OFF"}
                  </Text>
                </View>
              }
            />
            {notifGranted && (
              <>
                <Row
                  icon="radio"
                  label="Live Service Alerts"
                  right={
                    <ToggleSwitch
                      value={notifPrefs.liveAlerts}
                      onToggle={() => saveNotifPrefs({ liveAlerts: !notifPrefs.liveAlerts })}
                      label="Live Service Alerts"
                    />
                  }
                />
                <Row
                  icon="play-circle"
                  label="New Sermon Alerts"
                  right={
                    <ToggleSwitch
                      value={notifPrefs.newSermonAlerts}
                      onToggle={() => saveNotifPrefs({ newSermonAlerts: !notifPrefs.newSermonAlerts })}
                      label="New Sermon Alerts"
                    />
                  }
                />
                <Row
                  icon="alert-triangle"
                  label="Emergency Broadcasts"
                  right={
                    <ToggleSwitch
                      value={notifPrefs.emergencyAlerts}
                      onToggle={() => saveNotifPrefs({ emergencyAlerts: !notifPrefs.emergencyAlerts })}
                      label="Emergency Broadcasts"
                    />
                  }
                />
              </>
            )}
          </>
        ) : webPushSupported ? (
          // ── Web browser — W3C Web Push supported (Chrome, Edge, Firefox) ──
          <Row
            icon="bell"
            label="Push Notifications"
            description={
              webPushPermission === "granted"
                ? "Enabled – you'll receive live and sermon alerts"
                : webPushPermission === "denied"
                ? "Blocked in your browser settings"
                : webPushBusy
                ? "Requesting permission…"
                : "Tap to enable browser push notifications"
            }
            onPress={
              webPushPermission !== "granted" &&
              webPushPermission !== "denied" &&
              !webPushBusy
                ? handleWebPush
                : undefined
            }
            right={
              webPushBusy ? (
                <ActivityIndicator size="small" color={c.primary} />
              ) : (
                <View
                  style={[
                    styles.badge,
                    {
                      backgroundColor:
                        webPushPermission === "granted"
                          ? "#22c55e22"
                          : webPushPermission === "denied"
                          ? "#ef444422"
                          : c.muted,
                    },
                  ]}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "600",
                      color:
                        webPushPermission === "granted"
                          ? "#22c55e"
                          : webPushPermission === "denied"
                          ? "#ef4444"
                          : c.mutedForeground,
                    }}
                  >
                    {webPushPermission === "granted"
                      ? "ON"
                      : webPushPermission === "denied"
                      ? "BLOCKED"
                      : "OFF"}
                  </Text>
                </View>
              )
            }
          />
        ) : (
          // ── Web browser — push not supported (Safari < 16, old browsers) ──
          <Row
            icon="bell-off"
            label="Push notifications not available"
            description="Use Chrome, Edge, or Firefox to enable web push notifications"
          />
        )}
      </GlassCard>

      {/* Appearance */}
      <SectionTitle title="APPEARANCE" />
      <GlassCard style={styles.card}>
        <View style={[styles.row, { borderBottomColor: "transparent" }]}>
          <View style={[styles.rowIcon, { backgroundColor: c.primary + "22" }]}>
            <Feather name="monitor" size={16} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowLabel, { color: c.foreground }]}>Theme</Text>
            <Text style={[styles.rowDesc, { color: c.mutedForeground }]}>
              {theme === "system"
                ? "Auto (follows time of day)"
                : theme === "dark"
                ? "Always dark"
                : "Always light"}
            </Text>
          </View>
        </View>
        <View style={styles.themeRow}>
          {(["system", "light", "dark"] as ThemeChoice[]).map((opt) => (
            <Pressable
              key={opt}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                void setTheme(opt);
              }}
              style={[
                styles.themeOption,
                {
                  backgroundColor: theme === opt ? c.primary : c.card,
                  borderColor: theme === opt ? c.primary : c.border,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                opt === "system" ? "Auto theme" : opt === "dark" ? "Dark theme" : "Light theme"
              }
              accessibilityState={{ selected: theme === opt }}
            >
              <Feather
                name={opt === "system" ? "clock" : opt === "dark" ? "moon" : "sun"}
                size={14}
                color={theme === opt ? "#fff" : c.foreground}
              />
              <Text
                style={[
                  styles.themeOptionText,
                  { color: theme === opt ? "#fff" : c.foreground },
                ]}
              >
                {opt === "system" ? "Auto" : opt === "light" ? "Light" : "Dark"}
              </Text>
            </Pressable>
          ))}
        </View>
      </GlassCard>

      {/* My Content */}
      <SectionTitle title="MY CONTENT" />
      <GlassCard style={styles.card}>
        <Row
          icon="clock"
          label="Watch History"
          value={`${history.length} video${history.length !== 1 ? "s" : ""}`}
          onPress={() => router.push("/history")}
        />
        <Row
          icon="heart"
          label="Favorites"
          value={`${favorites.length} saved`}
          onPress={() => router.push("/favorites")}
        />
        <Row
          icon="list"
          label="Playlists"
          description="Browse curated sermon playlists"
          onPress={() => router.push("/playlists")}
        />
        <Row
          icon="book-open"
          label="Sermon Series"
          description="Multi-part teaching series"
          onPress={() => router.push("/(tabs)/library")}
        />
      </GlassCard>

      {/* Links */}
      <SectionTitle title="TEMPLE TV" />
      <GlassCard style={styles.card}>
        <Row
          icon="youtube"
          label="YouTube Channel"
          description={APP_CONFIG.channelName}
          onPress={() => Linking.openURL(APP_CONFIG.channelUrl).catch(() => {})}
        />
        <Row
          icon="globe"
          label="Website"
          onPress={() => Linking.openURL("https://jctm.org.ng").catch(() => {})}
        />
        <Row
          icon="heart"
          label="Support Us"
          description="Partner with Temple TV JCTM"
          onPress={() => router.push("/donate")}
        />
        <Row
          icon="mail"
          label="Contact"
          onPress={() => Linking.openURL("mailto:info@templetv.org.ng").catch(() => {})}
        />
        <Row
          icon="shield"
          label="Privacy Policy"
          onPress={() => Linking.openURL("https://templetv.org.ng/privacy").catch(() => {})}
        />
        <Row
          icon="file-text"
          label="Terms of Service"
          onPress={() => Linking.openURL("https://templetv.org.ng/terms").catch(() => {})}
        />
      </GlassCard>

      {/* App info */}
      <View style={styles.appInfo}>
        <Logo />
        <Text style={[styles.appVersion, { color: c.mutedForeground }]}>
          Temple TV · v{APP_VERSION}
        </Text>
        <Text style={[styles.appTagline, { color: c.mutedForeground }]}>
          Changing lives with the word of God
        </Text>
      </View>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 6,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 14,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: { fontSize: 15, fontWeight: "500" },
  rowDesc: { fontSize: 12, marginTop: 1 },
  rowValue: { fontSize: 12, marginTop: 1 },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 18, fontWeight: "700", color: "#fff" },
  profileName: { fontSize: 16, fontWeight: "600" },
  profileEmail: { fontSize: 13 },
  switch: {
    width: 44,
    height: 24,
    borderRadius: 12,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  thumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#fff",
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  themeRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 8,
  },
  themeOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  themeOptionText: { fontSize: 13, fontWeight: "600" },
  appInfo: {
    alignItems: "center",
    paddingVertical: 32,
    gap: 6,
  },
  appVersion: { fontSize: 13 },
  appTagline: { fontSize: 12 },
});
