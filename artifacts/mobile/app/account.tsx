/**
 * Account Screen — Temple TV Mobile
 *
 * Profile editing: display name, avatar initial, email (read-only),
 * change password shortcut, sign-out.
 */

import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/context/AuthContext";
import { updateProfile } from "@/services/api";
import { apiDeleteAccount } from "@/services/authApi";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { user, isLoggedIn, updateUser, signOut, forgetSession } = useAuth();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [deleting, setDeleting] = useState(false);
  // Custom cross-platform password-confirm modal. We cannot use Alert.prompt
  // because that API is iOS-only — on Android it is a no-op, which would
  // make account deletion silently impossible and block Play Store
  // compliance (Play policy requires in-app account deletion).
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const handleChangeName = useCallback((text: string) => {
    setDisplayName(text);
    setDirty(text.trim() !== (user?.displayName ?? "").trim());
  }, [user?.displayName]);

  const handleSave = useCallback(async () => {
    const name = displayName.trim();
    if (!name) {
      Alert.alert("Invalid Name", "Display name cannot be empty.");
      return;
    }
    setSaving(true);
    try {
      await updateProfile({ displayName: name });
      if (user) {
        updateUser({ ...user, displayName: name });
      }
      setDirty(false);
      Alert.alert("Saved", "Your profile has been updated.");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }, [displayName, user, updateUser]);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      "Delete account?",
      "This permanently removes your account, watch history, favourites, and all personal data from Temple TV. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          // Open the cross-platform password-confirm modal. iOS used to use
          // Alert.prompt here, but Android has no equivalent — using a Modal
          // for both keeps the flow identical on every platform.
          onPress: () => {
            setDeletePassword("");
            setDeleteError(null);
            setDeleteModalOpen(true);
          },
        },
      ],
    );
  }, []);

  const confirmDeleteAccount = useCallback(async () => {
    const password = deletePassword.trim();
    if (!password) {
      setDeleteError("Please enter your current password to confirm.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiDeleteAccount(password);
      // forgetSession is a local-only wipe; apiDeleteAccount already cleared
      // tokens, but this also flushes user-scoped caches (favorites/history)
      // so a future sign-in on this device starts clean.
      await forgetSession();
      // forgetSession clears auth state and may cause this screen to unmount
      // before these setState calls execute — guard with mountedRef to avoid
      // "state update on an unmounted component" warnings.
      if (mountedRef.current) {
        setDeleteModalOpen(false);
        setDeletePassword("");
      }
      Alert.alert("Account deleted", "Your account has been permanently removed.", [
        { text: "OK", onPress: () => router.replace("/(tabs)") },
      ]);
    } catch (err) {
      if (mountedRef.current) {
        setDeleteError(err instanceof Error ? err.message : "Couldn't delete account. Please try again.");
      }
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  }, [deletePassword, forgetSession]);

  const handleSignOut = useCallback(() => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
          } catch {
            // Best-effort — local session is cleared regardless of network errors.
          }
          router.replace("/(tabs)/settings");
        },
      },
    ]);
  }, [signOut]);

  if (!isLoggedIn || !user) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <StatusBar barStyle={c.isMidnightTheme ? "light-content" : "dark-content"} />
        <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: c.border }]}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
            <Feather name="arrow-left" size={22} color={c.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: c.foreground }]}>Account</Text>
        </View>
        <View style={styles.centered}>
          <Feather name="user" size={52} color={c.mutedForeground} />
          <Text style={[styles.guestTitle, { color: c.foreground }]}>Not Signed In</Text>
          <Text style={[styles.guestDesc, { color: c.mutedForeground }]}>
            Sign in to manage your profile, sync your watch history across devices, and access
            member features.
          </Text>
          <Pressable
            onPress={() => router.push("/login")}
            style={[styles.signInBtn, { backgroundColor: c.primary }]}
          >
            <Text style={styles.signInText}>Sign In</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const initials = getInitials(user.displayName || user.email || "T");
  const roleLabel = (user as unknown as { role?: string }).role
    ? String((user as unknown as { role?: string }).role)
    : null;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <StatusBar barStyle={c.isMidnightTheme ? "light-content" : "dark-content"} />

      {/* ── Header ────────────────────────────────────────────────────── */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: c.border, backgroundColor: c.background },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={12} accessibilityLabel="Go back">
          <Feather name="arrow-left" size={22} color={c.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Edit Profile</Text>
        {dirty && (
          <Pressable
            onPress={handleSave}
            style={[styles.saveBtn, { backgroundColor: c.primary }]}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.saveBtnText}>Save</Text>
            )}
          </Pressable>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Avatar ──────────────────────────────────────────────────── */}
        <View style={styles.avatarSection}>
          <View style={[styles.avatar, { backgroundColor: c.primary }]}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          {roleLabel && (
            <View style={[styles.roleBadge, { backgroundColor: c.primary + "22" }]}>
              <Text style={[styles.roleText, { color: c.primary }]}>
                {roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)}
              </Text>
            </View>
          )}
        </View>

        {/* ── Fields ──────────────────────────────────────────────────── */}
        <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>DISPLAY NAME</Text>
          <TextInput
            style={[styles.textField, { color: c.foreground, borderBottomColor: c.border }]}
            value={displayName}
            onChangeText={handleChangeName}
            placeholder="Your name"
            placeholderTextColor={c.mutedForeground}
            autoCorrect={false}
            returnKeyType="done"
            maxLength={60}
          />

          <Text style={[styles.sectionLabel, { color: c.mutedForeground, marginTop: 20 }]}>
            EMAIL ADDRESS
          </Text>
          <View style={[styles.readonlyField, { borderBottomColor: c.border }]}>
            <Text style={[styles.readonlyText, { color: c.foreground }]}>{user.email}</Text>
            <View style={[styles.verifiedBadge, { backgroundColor: user.emailVerified ? "#22c55e22" : "#f59e0b22" }]}>
              <Text style={[styles.verifiedText, { color: user.emailVerified ? "#22c55e" : "#f59e0b" }]}>
                {user.emailVerified ? "Verified" : "Unverified"}
              </Text>
            </View>
          </View>
        </View>

        {/* ── Actions ─────────────────────────────────────────────────── */}
        <View style={styles.actionList}>
          <Pressable
            onPress={() => router.push("/change-password")}
            style={[styles.actionRow, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <View style={[styles.actionIcon, { backgroundColor: c.primary + "22" }]}>
              <Feather name="lock" size={17} color={c.primary} />
            </View>
            <Text style={[styles.actionLabel, { color: c.foreground }]}>Change Password</Text>
            <Feather name="chevron-right" size={16} color={c.mutedForeground} />
          </Pressable>

          <Pressable
            onPress={() => router.push("/history")}
            style={[styles.actionRow, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <View style={[styles.actionIcon, { backgroundColor: c.primary + "22" }]}>
              <Feather name="clock" size={17} color={c.primary} />
            </View>
            <Text style={[styles.actionLabel, { color: c.foreground }]}>Watch History</Text>
            <Feather name="chevron-right" size={16} color={c.mutedForeground} />
          </Pressable>

          <Pressable
            onPress={() => router.push("/favorites" as never)}
            style={[styles.actionRow, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <View style={[styles.actionIcon, { backgroundColor: c.primary + "22" }]}>
              <Feather name="heart" size={17} color={c.primary} />
            </View>
            <Text style={[styles.actionLabel, { color: c.foreground }]}>Saved Videos</Text>
            <Feather name="chevron-right" size={16} color={c.mutedForeground} />
          </Pressable>

          <Pressable
            onPress={handleSignOut}
            style={[styles.actionRow, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <View style={[styles.actionIcon, { backgroundColor: "#ef444422" }]}>
              <Feather name="log-out" size={17} color="#ef4444" />
            </View>
            <Text style={[styles.actionLabel, { color: "#ef4444" }]}>Sign Out</Text>
          </Pressable>

          <Pressable
            onPress={handleDeleteAccount}
            disabled={deleting}
            style={[styles.actionRow, { backgroundColor: c.card, borderColor: c.border, opacity: deleting ? 0.6 : 1 }]}
          >
            <View style={[styles.actionIcon, { backgroundColor: "#ef444422" }]}>
              {deleting ? (
                <ActivityIndicator size="small" color="#ef4444" />
              ) : (
                <Feather name="trash-2" size={17} color="#ef4444" />
              )}
            </View>
            <Text style={[styles.actionLabel, { color: "#ef4444" }]}>
              {deleting ? "Deleting account..." : "Delete Account"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* ── Cross-platform delete-account confirmation modal ────────── */}
      <Modal
        visible={deleteModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!deleting) setDeleteModalOpen(false); }}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: c.card, borderColor: c.border }]}>
            <View style={[styles.modalIcon, { backgroundColor: "#ef444422" }]}>
              <Feather name="alert-triangle" size={22} color="#ef4444" />
            </View>
            <Text style={[styles.modalTitle, { color: c.foreground }]}>Confirm with password</Text>
            <Text style={[styles.modalBody, { color: c.mutedForeground }]}>
              Enter your current password to permanently delete your account. This action cannot be undone.
            </Text>
            <TextInput
              style={[styles.modalInput, { color: c.foreground, borderColor: c.border, backgroundColor: c.background }]}
              value={deletePassword}
              onChangeText={(t) => { setDeletePassword(t); if (deleteError) setDeleteError(null); }}
              placeholder="Current password"
              placeholderTextColor={c.mutedForeground}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              autoFocus
              editable={!deleting}
              returnKeyType="done"
              onSubmitEditing={confirmDeleteAccount}
            />
            {deleteError && (
              <Text style={styles.modalError}>{deleteError}</Text>
            )}
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => { if (!deleting) { setDeleteModalOpen(false); setDeletePassword(""); setDeleteError(null); } }}
                disabled={deleting}
                style={[styles.modalBtn, { backgroundColor: "transparent", borderColor: c.border, borderWidth: 1 }]}
              >
                <Text style={[styles.modalBtnText, { color: c.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmDeleteAccount}
                disabled={deleting}
                style={[styles.modalBtn, { backgroundColor: "#ef4444", opacity: deleting ? 0.7 : 1 }]}
              >
                {deleting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[styles.modalBtnText, { color: "#fff" }]}>Delete account</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  saveBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 70,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },

  content: { padding: 16, gap: 16 },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 14,
  },
  guestTitle: { fontSize: 20, fontWeight: "700" },
  guestDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  signInBtn: {
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: 24,
    marginTop: 8,
  },
  signInText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  avatarSection: { alignItems: "center", paddingVertical: 16, gap: 10 },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  avatarText: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  roleBadge: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
  },
  roleText: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },

  section: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 4,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  textField: {
    fontSize: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  readonlyField: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  readonlyText: { flex: 1, fontSize: 16 },
  verifiedBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  verifiedText: { fontSize: 11, fontWeight: "700" },

  actionList: { gap: 10 },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { flex: 1, fontSize: 15, fontWeight: "600" },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 18,
    borderWidth: 1,
    padding: 22,
    gap: 12,
  },
  modalIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
    alignSelf: "flex-start",
  },
  modalTitle: { fontSize: 18, fontWeight: "700", letterSpacing: -0.2 },
  modalBody: { fontSize: 14, lineHeight: 20 },
  modalInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 15,
    marginTop: 4,
  },
  modalError: {
    color: "#ef4444",
    fontSize: 13,
    marginTop: -4,
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  modalBtn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnText: { fontSize: 15, fontWeight: "700" },
});
