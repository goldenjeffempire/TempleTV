import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  KeyboardAvoidingView,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { BroadcastCurrentResult, ReactionType } from "@/services/broadcast";
import type { LiveBarTab } from "@/components/BroadcastLiveBar";
import { PrayerRequestModal } from "@/components/PrayerRequestModal";
import { useChat } from "@/lib/chat/useChat";
import { TEMPLE_TV_LIVE_CHANNEL } from "@/lib/chat/types";

/**
 * Expandable bottom sheet that pairs with `BroadcastLiveBar`.
 *
 * Five tabs — Chat · Prayer · Schedule · Donate · Settings — surfaced as
 * a horizontal segmented strip at the top of the sheet. The active tab's
 * content scrolls inside the sheet. The sheet animates from off-screen
 * (closed) to a fixed snap height (~78% of the viewport, capped at 720px
 * on tablet/desktop centered columns), driven by a single Animated.Value
 * so transitions stay 60fps on web + native without reanimated runtime.
 *
 * Gestures:
 *   - Pull-down on the drag handle dismisses (PanResponder).
 *   - Tap on the dimmed backdrop dismisses.
 *   - Web Escape key dismisses (window keydown listener, only while open).
 *   - Android hardware back-button dismisses (`BackHandler.addEventListener
 *     "hardwareBackPress"`, only while open). Returning `true` from the
 *     handler stops React Navigation from also processing the press, so
 *     the back button closes the sheet without ALSO popping the player
 *     screen underneath. The listener is attached only while `visible` is
 *     true so it doesn't conflict with other modals' BackHandler usage.
 *
 * Chat tab connects to the api-server's `/api/chat/ws` WebSocket via the
 * shared `useChat` hook (lib/chat/useChat.ts). It mirrors the
 * TV/admin chat clients — same frame contract, same reconnect behaviour
 * — and is rendered as guest by default; moderator auth happens through
 * the admin app, not this consumer surface.
 *
 * Schedule reads from the existing BroadcastCurrentResult (`currentItem` +
 * `upcomingItems`); Donate links to the existing `/donate` page; Settings
 * exposes the two playback preferences the player already supports
 * (data saver + radio mode) plus notifications opt-in.
 */

interface Props {
  visible: boolean;
  activeTab: LiveBarTab;
  onTabChange: (tab: LiveBarTab) => void;
  onClose: () => void;
  broadcast: BroadcastCurrentResult | null;
  viewers: number | null;
  isLive: boolean;
  isRadioMode: boolean;
  onToggleRadioMode: () => void;
  dataSaver: boolean;
  onToggleDataSaver: () => void;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onSendReaction: (type: ReactionType) => void;
  onShare: () => void;
}

const TAB_DEFS: Array<{ key: LiveBarTab; label: string; icon: keyof typeof Feather.glyphMap }> = [
  { key: "chat", label: "Chat", icon: "message-circle" },
  { key: "prayer", label: "Prayer", icon: "heart" },
  { key: "schedule", label: "Schedule", icon: "calendar" },
  { key: "donate", label: "Donate", icon: "gift" },
  { key: "settings", label: "Settings", icon: "settings" },
];

export function BroadcastLiveSheet({
  visible,
  activeTab,
  onTabChange,
  onClose,
  broadcast,
  viewers,
  isLive,
  isRadioMode,
  onToggleRadioMode,
  dataSaver,
  onToggleDataSaver,
  notificationsEnabled,
  onToggleNotifications,
  onSendReaction,
  onShare,
}: Props) {
  const { height: winH, width: winW } = useWindowDimensions();
  // Cap sheet height: 78vh on phones, but never above 720px on tablet/desktop.
  const sheetHeight = useMemo(
    () => Math.min(Math.round(winH * 0.78), 720),
    [winH],
  );
  // Centered max-width column for tablet / desktop web — same envelope the
  // player chrome uses (1280-wide center column).
  const sheetMaxWidth = winW > 768 ? 720 : winW;

  const translateY = useRef(new Animated.Value(sheetHeight)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  // The drag-during-open offset; reset on release.
  const dragY = useRef(new Animated.Value(0)).current;

  // Refs so the PanResponder (created once via useRef) always reads the
  // current values without being recreated. Without this, both `sheetHeight`
  // and `onClose` are frozen at their initial-render values inside the
  // responder's closures — rotation changes `sheetHeight` (wrong dismiss
  // threshold) and any prop-identity change to `onClose` goes unnoticed.
  const onCloseRef = useRef(onClose);
  const sheetHeightRef = useRef(sheetHeight);
  onCloseRef.current = onClose;
  sheetHeightRef.current = sheetHeight;

  // ── Open / close animation ──
  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: visible ? 0 : sheetHeight,
        duration: visible ? 280 : 220,
        easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: visible ? 1 : 0,
        duration: visible ? 240 : 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, sheetHeight, translateY, backdropOpacity]);

  // ── Pan-down to dismiss ──
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4 && g.dy > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) dragY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        // Release threshold: dragged > 25% of sheet OR fast flick down.
        // Use sheetHeightRef so a device rotation updates the threshold
        // without recreating the entire PanResponder.
        if (g.dy > sheetHeightRef.current * 0.25 || g.vy > 1.2) {
          Animated.timing(dragY, { toValue: 0, duration: 0, useNativeDriver: true }).start();
          if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onCloseRef.current();
        } else {
          Animated.spring(dragY, { toValue: 0, friction: 7, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  // Combined transform: open animation + pan drag.
  const composedY = Animated.add(translateY, dragY);

  // ── Dismiss on platform-native "back" affordance ──
  //
  //   - Web: Escape key (window keydown).
  //   - Android: hardware back button (BackHandler). Returning `true`
  //     consumes the event so the navigator doesn't ALSO pop the player
  //     screen underneath the sheet on the same press.
  //   - iOS: gesture-back is handled by the navigator at the screen
  //     level; the sheet itself uses pan-to-dismiss + backdrop tap.
  //
  // Both listeners attach only while `visible === true` so we never
  // interfere with other modals' or screens' back-handling stacks.
  useEffect(() => {
    if (!visible) return;
    if (Platform.OS === "web") {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    if (Platform.OS === "android") {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        onClose();
        return true;
      });
      return () => sub.remove();
    }
    return undefined;
  }, [visible, onClose]);

  // Don't render the sheet at all when fully closed — saves layout cost
  // on the player tree, especially on lower-end Androids. Use a small
  // post-close grace so the closing animation can complete.
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), 260);
    return () => clearTimeout(t);
  }, [visible]);

  if (!mounted) return null;

  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: visible ? "auto" : "none" }]}>
      {/* Backdrop — tap to dismiss */}
      <Animated.View
        style={[styles.backdrop, { opacity: backdropOpacity, pointerEvents: visible ? "auto" : "none" }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close panel" />
      </Animated.View>

      {/* Sheet */}
      <Animated.View
        style={[
          styles.sheet,
          {
            height: sheetHeight,
            maxWidth: sheetMaxWidth,
            transform: [{ translateY: composedY }],
          },
        ]}
      >
        {/* Drag handle area — owns the pan-to-close gesture. */}
        <View {...panResponder.panHandlers} style={styles.dragArea}>
          <View style={styles.dragHandle} />
        </View>

        {/* Tab strip */}
        <View style={styles.tabStrip}>
          {TAB_DEFS.map((t) => {
            const active = t.key === activeTab;
            return (
              <Pressable
                key={t.key}
                style={({ pressed }) => [
                  styles.tabBtn,
                  active && styles.tabBtnActive,
                  pressed && !active && { opacity: 0.7 },
                ]}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.selectionAsync();
                  onTabChange(t.key);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t.label}
              >
                <Feather name={t.icon} size={15} color={active ? "#FFF" : "#9DA7B3"} />
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* Tab body */}
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          showsVerticalScrollIndicator={false}
        >
          {activeTab === "chat" && <ChatTab isLive={isLive} viewers={viewers} />}
          {activeTab === "prayer" && <PrayerTab onClose={onClose} />}
          {activeTab === "schedule" && <ScheduleTab broadcast={broadcast} viewers={viewers} isLive={isLive} />}
          {activeTab === "donate" && <DonateTab onClose={onClose} />}
          {activeTab === "settings" && (
            <SettingsTab
              isRadioMode={isRadioMode}
              onToggleRadioMode={onToggleRadioMode}
              dataSaver={dataSaver}
              onToggleDataSaver={onToggleDataSaver}
              notificationsEnabled={notificationsEnabled}
              onToggleNotifications={onToggleNotifications}
              onShare={onShare}
              onSendReaction={onSendReaction}
            />
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Format a duration in seconds as `H:MM:SS` (or `M:SS` when under an hour).
 * Used in the Schedule tab as the secondary line under each item title.
 */
function formatDuration(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(h > 0 ? 2 : 1, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Tab content components
// ────────────────────────────────────────────────────────────────────────────

/**
 * Real-time chat panel.
 *
 * Wires the shared RN `ChatClient` to a chronological message list (newest
 * at the bottom) plus a single-line composer. Unsent / failed messages are
 * shown in the same list with a subdued style, so users see their own
 * message immediately even before the server's `ack` frame arrives — same
 * UX as the TV/admin clients.
 *
 * Layout caveat: this tab lives inside a parent ScrollView that already
 * scrolls the sheet. To prevent nested-scroll fighting, the message list
 * here uses a fixed-height inner ScrollView with `nestedScrollEnabled`,
 * and the composer sits below it (not inside it).
 */
const CHAT_LIST_HEIGHT = 280;

function ChatTab({ isLive, viewers }: { isLive: boolean; viewers: number | null }) {
  const chat = useChat({ channelId: TEMPLE_TV_LIVE_CHANNEL });
  const [draft, setDraft] = useState("");
  const listRef = useRef<ScrollView | null>(null);

  // Combine confirmed + pending into a single chronological view. Pending
  // entries become "ghost messages" rendered in our own colour scheme.
  const items = useMemo(() => {
    const confirmed = chat.messages.map((m) => ({
      kind: "confirmed" as const,
      key: m.id,
      displayName: m.displayName,
      body: m.body,
      createdAtMs: m.createdAtMs,
    }));
    const pending = chat.pending.map((p) => ({
      kind: "pending" as const,
      key: p.clientMsgId,
      displayName: chat.identity?.displayName ?? "You",
      body: p.body,
      createdAtMs: Date.now(),
      status: p.status,
      error: p.error,
    }));
    return [...confirmed, ...pending];
  }, [chat.messages, chat.pending, chat.identity?.displayName]);

  // Auto-scroll to the bottom whenever the message count changes — the
  // ScrollView is short enough that a non-animated jump feels right.
  useEffect(() => {
    const id = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 0);
    return () => clearTimeout(id);
  }, [items.length]);

  const canSend =
    chat.state === "open" && draft.trim().length > 0 && draft.trim().length <= 500;

  const onSubmit = () => {
    const body = draft.trim();
    if (!body) return;
    chat.send(body);
    setDraft("");
  };

  const statusLabel: string =
    chat.state === "open"
      ? "Live chat connected"
      : chat.state === "connecting"
        ? "Connecting…"
        : chat.state === "reconnecting"
          ? "Reconnecting…"
          : chat.state === "closed"
            ? "Disconnected"
            : "Idle";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ gap: 12 }}
    >
      {/* Header strip — same status pills as the previous placeholder so
          the visual rhythm of the sheet doesn't change. */}
      <View style={styles.chatHeaderRow}>
        <View style={styles.chatStatusGroup}>
          <View
            style={[
              styles.statusDot,
              {
                backgroundColor:
                  chat.state === "open"
                    ? "#22C55E"
                    : chat.state === "reconnecting" || chat.state === "connecting"
                      ? "#F59E0B"
                      : "#6B7280",
              },
            ]}
          />
          <Text style={styles.chatStatusText}>{statusLabel}</Text>
        </View>
        <View style={styles.chatHeaderPills}>
          <View style={styles.statusPill}>
            <View
              style={[styles.statusDot, { backgroundColor: isLive ? "#FF0040" : "#666" }]}
            />
            <Text style={styles.statusPillText}>{isLive ? "On air" : "Off air"}</Text>
          </View>
          {viewers !== null && (
            <View style={styles.statusPill}>
              <Feather name="users" size={11} color="#9DA7B3" />
              <Text style={styles.statusPillText}>{viewers}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Message list */}
      <View style={[styles.chatListWrap, { height: CHAT_LIST_HEIGHT }]}>
        {chat.state === "connecting" && items.length === 0 ? (
          <View style={styles.chatEmptyState}>
            <ActivityIndicator color="#FF6B9D" />
            <Text style={styles.chatEmptyHint}>Joining the conversation…</Text>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.chatEmptyState}>
            <Feather name="message-circle" size={26} color="#FF6B9D" />
            <Text style={styles.chatEmptyHint}>
              No messages yet. Be the first to say hi.
            </Text>
          </View>
        ) : (
          <ScrollView
            ref={listRef}
            style={{ flex: 1 }}
            contentContainerStyle={styles.chatListContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            {items.map((it) => (
              <View key={it.key} style={styles.chatRow}>
                <Text style={styles.chatAuthor}>{it.displayName}</Text>
                <Text
                  style={[
                    styles.chatBody,
                    it.kind === "pending" && it.status !== "error" && styles.chatBodyPending,
                    it.kind === "pending" && it.status === "error" && styles.chatBodyError,
                  ]}
                >
                  {it.body}
                </Text>
                {it.kind === "pending" && it.status === "error" && it.error && (
                  <Text style={styles.chatError}>{it.error}</Text>
                )}
              </View>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Surfaced last-error banner (rate limit, mute, etc) — only shown
          when there are no pending messages of our own to attach the
          error to, otherwise the inline pending row already explains it. */}
      {chat.lastError && chat.pending.length === 0 && (
        <View style={styles.chatErrorBanner}>
          <Feather name="alert-circle" size={13} color="#F87171" />
          <Text style={styles.chatErrorBannerText}>{chat.lastError.message}</Text>
        </View>
      )}

      {/* Composer */}
      <View style={styles.chatComposer}>
        <TextInput
          style={styles.chatInput}
          value={draft}
          onChangeText={setDraft}
          placeholder={chat.state === "open" ? "Say something kind…" : "Connecting…"}
          placeholderTextColor="#6B7280"
          editable={chat.state === "open"}
          maxLength={500}
          returnKeyType="send"
          onSubmitEditing={onSubmit}
          blurOnSubmit={false}
          accessibilityLabel="Live chat message"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={onSubmit}
          style={({ pressed }) => [
            styles.chatSendBtn,
            !canSend && styles.chatSendBtnDisabled,
            pressed && canSend && { opacity: 0.85 },
          ]}
        >
          <Feather name="send" size={16} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function PrayerTab({ onClose: _onClose }: { onClose: () => void }) {
  const [modalVisible, setModalVisible] = useState(false);
  return (
    <View style={{ gap: 14 }}>
      <View style={styles.heroCard}>
        <Text style={styles.heroEmoji}>🙏</Text>
        <Text style={styles.heroTitle}>Send a prayer request</Text>
        <Text style={styles.heroBody}>
          Our intercessors will lift up your request during today's broadcast.
          Submit anonymously or include your name — it's entirely up to you.
        </Text>
        <Pressable
          style={({ pressed }) => [styles.heroPrimaryBtn, pressed && { opacity: 0.85 }]}
          onPress={() => {
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setModalVisible(true);
          }}
        >
          <Feather name="edit-3" size={16} color="#FFF" />
          <Text style={styles.heroPrimaryBtnText}>Submit a request</Text>
        </Pressable>
      </View>

      <View style={styles.infoCard}>
        <View style={styles.infoCardHeader}>
          <Feather name="shield" size={14} color="#9DA7B3" />
          <Text style={styles.infoCardTitle}>Your privacy</Text>
        </View>
        <Text style={styles.infoCardBody}>
          Prayer requests are kept private between you and our pastoral
          team. Submissions are never shown publicly in the app or on stream.
        </Text>
      </View>

      <PrayerRequestModal visible={modalVisible} onClose={() => setModalVisible(false)} />
    </View>
  );
}

function ScheduleTab({
  broadcast,
  viewers,
  isLive,
}: {
  broadcast: BroadcastCurrentResult | null;
  viewers: number | null;
  isLive: boolean;
}) {
  const current = broadcast?.item;
  const upcoming = (broadcast?.upcomingItems ?? []).filter((it) => it && it.title).slice(0, 6);

  return (
    <View style={{ gap: 14 }}>
      {/* Now on air */}
      <View style={styles.scheduleNowCard}>
        <View style={styles.scheduleNowBadgeRow}>
          <View style={styles.nowBadge}>
            <View style={[styles.nowDot, { backgroundColor: isLive ? "#FF0040" : "#666" }]} />
            <Text style={[styles.nowLabel, !isLive && { color: "#9DA7B3" }]}>
              {isLive ? "NOW ON AIR" : "OFF AIR"}
            </Text>
          </View>
          {viewers !== null && (
            <View style={styles.viewersBadge}>
              <Feather name="users" size={11} color="#9DA7B3" />
              <Text style={styles.viewersBadgeText}>{viewers}</Text>
            </View>
          )}
        </View>
        <Text style={styles.scheduleNowTitle} numberOfLines={2}>
          {current?.title ?? "No program scheduled"}
        </Text>
        {/* Duration meta — broadcast items don't carry preacher metadata
            (`BroadcastItem` is intentionally minimal: id/title/youtubeId/
            durationSecs/source) so we surface the runtime instead. */}
        {typeof current?.durationSecs === "number" && current.durationSecs > 0 && (
          <Text style={styles.scheduleNowMeta} numberOfLines={1}>
            {formatDuration(current.durationSecs)}
          </Text>
        )}
      </View>

      {/* Up next list */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>Coming up</Text>
        <Text style={styles.sectionHeaderHint}>Next {upcoming.length}</Text>
      </View>
      {upcoming.length === 0 ? (
        <View style={styles.emptyState}>
          <Feather name="calendar" size={20} color="#5A6470" />
          <Text style={styles.emptyStateText}>The schedule will appear here as the queue advances.</Text>
        </View>
      ) : (
        upcoming.map((it, idx) => (
          <View key={`${it.title}-${idx}`} style={styles.scheduleRow}>
            <Text style={styles.scheduleRowIdx}>{String(idx + 1).padStart(2, "0")}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.scheduleRowTitle} numberOfLines={1}>
                {it.title}
              </Text>
              {typeof it.durationSecs === "number" && it.durationSecs > 0 && (
                <Text style={styles.scheduleRowMeta} numberOfLines={1}>
                  {formatDuration(it.durationSecs)}
                </Text>
              )}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function DonateTab({ onClose }: { onClose: () => void }) {
  return (
    <View style={{ gap: 14 }}>
      <View style={styles.heroCard}>
        <Text style={styles.heroEmoji}>💜</Text>
        <Text style={styles.heroTitle}>Partner with the ministry</Text>
        <Text style={styles.heroBody}>
          Your seed sustains free 24/7 broadcasting to the world. Every gift —
          large or small — helps us keep the broadcast on air.
        </Text>
        <Pressable
          style={({ pressed }) => [styles.heroPrimaryBtn, pressed && { opacity: 0.85 }]}
          onPress={() => {
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onClose();
            // Defer navigation by one frame so the close animation kicks off
            // before expo-router unmounts the sheet — feels noticeably smoother
            // on lower-end Androids.
            requestAnimationFrame(() => router.push("/donate"));
          }}
        >
          <Feather name="gift" size={16} color="#FFF" />
          <Text style={styles.heroPrimaryBtnText}>Open giving options</Text>
        </Pressable>
      </View>

      <View style={styles.infoCard}>
        <View style={styles.infoCardHeader}>
          <Feather name="info" size={14} color="#9DA7B3" />
          <Text style={styles.infoCardTitle}>Account names & details</Text>
        </View>
        <Text style={styles.infoCardBody}>
          The full giving page lists Naira and USD bank accounts with copy-to-clipboard
          shortcuts and donation tier suggestions.
        </Text>
      </View>
    </View>
  );
}

function SettingsTab({
  isRadioMode,
  onToggleRadioMode,
  dataSaver,
  onToggleDataSaver,
  notificationsEnabled,
  onToggleNotifications,
  onShare,
  onSendReaction,
}: {
  isRadioMode: boolean;
  onToggleRadioMode: () => void;
  dataSaver: boolean;
  onToggleDataSaver: () => void;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onShare: () => void;
  onSendReaction: (type: ReactionType) => void;
}) {
  return (
    <View style={{ gap: 10 }}>
      <SettingRow
        icon="headphones"
        title="Audio only"
        subtitle="Listen to the broadcast as a radio stream"
        value={isRadioMode}
        onValueChange={onToggleRadioMode}
      />
      <SettingRow
        icon="wifi-off"
        title="Data saver"
        subtitle="Prefer lower video quality on cellular networks"
        value={dataSaver}
        onValueChange={onToggleDataSaver}
      />
      <SettingRow
        icon="bell"
        title="Live notifications"
        subtitle="Get notified the moment we go on air"
        value={notificationsEnabled}
        onValueChange={onToggleNotifications}
      />

      <View style={styles.sectionDivider} />

      <Text style={styles.sectionHeader}>Quick actions</Text>
      <View style={styles.actionGrid}>
        <Pressable
          style={({ pressed }) => [styles.actionTile, pressed && { opacity: 0.85 }]}
          onPress={onShare}
        >
          <Feather name="share-2" size={16} color="#E6EDF3" />
          <Text style={styles.actionTileLabel}>Share stream</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.actionTile, pressed && { opacity: 0.85 }]}
          onPress={() => onSendReaction("amen")}
        >
          <Text style={{ fontSize: 16 }}>🙌</Text>
          <Text style={styles.actionTileLabel}>Send Amen</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.actionTile, pressed && { opacity: 0.85 }]}
          onPress={() => Linking.openURL("https://www.youtube.com/@templetvjctm").catch(() => {})}
        >
          <Feather name="youtube" size={16} color="#FF0000" />
          <Text style={styles.actionTileLabel}>YouTube</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SettingRow({
  icon,
  title,
  subtitle,
  value,
  onValueChange,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingIconRing}>
        <Feather name={icon} size={15} color="#E6EDF3" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingSubtitle}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: "#3a3f47", true: "#6A0DAD" }}
        thumbColor={Platform.OS === "android" ? "#FFF" : undefined}
      />
    </View>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#0d1117",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
    alignSelf: "center",
    width: "100%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 24,
  },
  dragArea: {
    paddingTop: 8,
    paddingBottom: 6,
    alignItems: "center",
  },
  dragHandle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  // ── Tab strip ──
  tabStrip: {
    flexDirection: "row",
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  tabBtnActive: {
    backgroundColor: "rgba(106,13,173,0.28)",
  },
  tabLabel: {
    color: "#9DA7B3",
    fontSize: 11,
    fontWeight: "600",
  },
  tabLabelActive: {
    color: "#FFF",
    fontWeight: "700",
  },
  // ── Body ──
  body: { flex: 1 },
  bodyContent: {
    padding: 16,
    paddingBottom: 24,
    gap: 12,
  },
  // ── Generic placeholder card (Chat tab) ──
  placeholderCard: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 14,
    padding: 22,
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.06)",
  },
  placeholderIconRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255,107,157,0.15)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  placeholderTitle: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  placeholderBody: {
    color: "#9DA7B3",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },
  placeholderStatusRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillText: {
    color: "#C9D1D9",
    fontSize: 11,
    fontWeight: "600",
  },
  // ── Hero card (Prayer / Donate tabs) ──
  heroCard: {
    backgroundColor: "rgba(106,13,173,0.18)",
    borderRadius: 14,
    padding: 18,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(106,13,173,0.35)",
  },
  heroEmoji: {
    fontSize: 28,
    lineHeight: 34,
  },
  heroTitle: {
    color: "#FFF",
    fontSize: 17,
    fontWeight: "700",
  },
  heroBody: {
    color: "#C9D1D9",
    fontSize: 13,
    lineHeight: 19,
  },
  heroPrimaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#6A0DAD",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginTop: 8,
  },
  heroPrimaryBtnText: {
    color: "#FFF",
    fontSize: 14,
    fontWeight: "700",
  },
  // ── Info card (secondary explanatory cards) ──
  infoCard: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    padding: 14,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.06)",
  },
  infoCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  infoCardTitle: {
    color: "#E6EDF3",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  infoCardBody: {
    color: "#9DA7B3",
    fontSize: 12,
    lineHeight: 17,
  },
  // ── Schedule tab ──
  scheduleNowCard: {
    backgroundColor: "rgba(255,0,64,0.10)",
    borderRadius: 14,
    padding: 14,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,0,64,0.25)",
  },
  scheduleNowBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  nowBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  nowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  nowLabel: {
    color: "#FF0040",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  viewersBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  viewersBadgeText: {
    color: "#C9D1D9",
    fontSize: 11,
    fontWeight: "700",
  },
  scheduleNowTitle: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 21,
  },
  scheduleNowMeta: {
    color: "#9DA7B3",
    fontSize: 12,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingTop: 4,
  },
  sectionHeader: {
    color: "#E6EDF3",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  sectionHeaderHint: {
    color: "#5A6470",
    fontSize: 11,
    fontWeight: "600",
  },
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 10,
  },
  scheduleRowIdx: {
    color: "#5A6470",
    fontSize: 11,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    width: 22,
  },
  scheduleRowTitle: {
    color: "#E6EDF3",
    fontSize: 13,
    fontWeight: "600",
  },
  scheduleRowMeta: {
    color: "#7A8390",
    fontSize: 11,
    marginTop: 2,
  },
  emptyState: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 24,
    backgroundColor: "rgba(255,255,255,0.02)",
    borderRadius: 12,
  },
  emptyStateText: {
    color: "#5A6470",
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  // ── Settings tab ──
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  settingIconRing: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  settingTitle: {
    color: "#FFF",
    fontSize: 13,
    fontWeight: "700",
  },
  settingSubtitle: {
    color: "#9DA7B3",
    fontSize: 11,
    marginTop: 2,
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginVertical: 8,
  },
  actionGrid: {
    flexDirection: "row",
    gap: 8,
  },
  actionTile: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    gap: 6,
  },
  actionTileLabel: {
    color: "#C9D1D9",
    fontSize: 11,
    fontWeight: "600",
  },
  // ── Chat tab ──
  chatHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  chatStatusGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  chatStatusText: {
    color: "#9DA7B3",
    fontSize: 12,
    fontWeight: "600",
  },
  chatHeaderPills: {
    flexDirection: "row",
    gap: 6,
    flexShrink: 0,
  },
  chatListWrap: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  chatListContent: {
    padding: 12,
    gap: 10,
  },
  chatRow: {
    gap: 2,
  },
  chatAuthor: {
    color: "#FF6B9D",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  chatBody: {
    color: "#E5E7EB",
    fontSize: 14,
    lineHeight: 19,
  },
  chatBodyPending: {
    color: "rgba(229,231,235,0.55)",
    fontStyle: "italic",
  },
  chatBodyError: {
    color: "#FCA5A5",
  },
  chatError: {
    color: "#F87171",
    fontSize: 11,
    marginTop: 2,
  },
  chatEmptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 16,
  },
  chatEmptyHint: {
    color: "#9DA7B3",
    fontSize: 13,
    textAlign: "center",
  },
  chatErrorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(248,113,113,0.10)",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(248,113,113,0.35)",
  },
  chatErrorBannerText: {
    color: "#FCA5A5",
    fontSize: 12,
    flexShrink: 1,
  },
  chatComposer: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
  },
  chatInput: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 12 : 8,
    color: "#FFF",
    fontSize: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.10)",
    minHeight: 42,
  },
  chatSendBtn: {
    width: 44,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#FF6B9D",
    alignItems: "center",
    justifyContent: "center",
  },
  chatSendBtnDisabled: {
    backgroundColor: "rgba(255,107,157,0.35)",
  },
});
