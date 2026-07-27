/**
 * Live chat panel — YouTube-grade broadcast chat UI.
 *
 * Features:
 *   • Role badges with colour-coded names (admin=gold, mod=blue, user=purple, guest=dim)
 *   • Pinned message sticky banner (dismissible per-pin)
 *   • Highlighted messages with amber left border
 *   • Reaction bar — tap a pill to toggle your emoji reaction
 *   • 8-emoji quick-access tray (expandable from emoji button)
 *   • Slow-mode countdown in input area; send button disabled while cooling
 *   • Subscriber-only notice for unauthenticated guests
 *   • "↓ N new" floating pill when user has scrolled up; resumes auto-scroll on tap
 *   • Optimised FlatList: maxToRenderPerBatch, windowSize, removeClippedSubviews,
 *     stable memoised renderItem, per-item React.memo
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useChat } from "@/lib/chat/useChat";
import type { ChatMessage, ChatRole } from "@/lib/chat/types";
import { useColors } from "@/hooks/useColors";
import { getApiBase } from "@/lib/apiBase";

const LIVE_CHANNEL_ID = "temple-tv-live";
const QUICK_EMOJIS = ["🙏", "🔥", "❤️", "😂", "👏", "🙌", "💯", "✨"];
const SCROLL_NEAR_BOTTOM_PX = 100;

// ── Role presentation ─────────────────────────────────────────────────────────
const ROLE_COLORS: Record<ChatRole, string> = {
  admin: "#f59e0b",
  mod: "#3b82f6",
  user: "#a855f7",
  guest: "rgba(255,255,255,0.40)",
};
const ROLE_PREFIX: Record<ChatRole, string> = {
  admin: "★ ",
  mod: "⚑ ",
  user: "",
  guest: "",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a timestamp as a short relative string: "just now", "2m", "1h", "Mon" */
function formatRelativeTime(ms: number): string {
  const diffSecs = Math.floor((Date.now() - ms) / 1000);
  if (diffSecs < 30) return "just now";
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m`;
  if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

/** Fire-and-forget REST report/moderation call; errors are swallowed intentionally. */
async function apiModAction(
  path: string,
  method: "POST" | "DELETE",
  token?: string | null,
): Promise<void> {
  const base = getApiBase();
  if (!base) return;
  try {
    await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    // Swallow — moderation calls are best-effort
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ConnectionBadge({
  state,
  onRetry,
}: {
  state: string;
  onRetry?: () => void;
}) {
  const color =
    state === "open"
      ? "#22c55e"
      : state === "connecting" || state === "reconnecting"
        ? "#f59e0b"
        : "#ef4444";
  const label =
    state === "open"
      ? "Live"
      : state === "connecting"
        ? "Connecting…"
        : state === "reconnecting"
          ? "Reconnecting…"
          : "Offline";

  const isOffline = state === "closed";

  if (isOffline && onRetry) {
    return (
      <TouchableOpacity
        style={styles.retryBtn}
        onPress={onRetry}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Tap to reconnect chat"
      >
        <Feather name="refresh-cw" size={10} color="#ef4444" />
        <Text style={styles.retryText}>Tap to reconnect</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.badge}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

interface MessageRowProps {
  msg: ChatMessage;
  onReact: (messageId: string, emoji: string) => void;
  onLongPress: (msg: ChatMessage) => void;
  isModerator: boolean;
}

const MessageRow = React.memo(function MessageRow({
  msg,
  onReact,
  onLongPress,
}: MessageRowProps) {
  const nameColor = ROLE_COLORS[msg.role] ?? ROLE_COLORS.guest;
  const prefix = ROLE_PREFIX[msg.role] ?? "";
  const sortedReactions = useMemo(
    () =>
      Object.entries(msg.reactions)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5),
    [msg.reactions],
  );

  return (
    <Pressable
      onLongPress={() => onLongPress(msg)}
      delayLongPress={400}
      style={({ pressed }) => [
        styles.msgRow,
        msg.isHighlighted && styles.msgRowHighlighted,
        pressed && styles.msgRowPressed,
      ]}
      accessibilityRole="text"
      accessibilityHint="Hold to report or moderate this message"
    >
      <View style={styles.msgHeader}>
        <Text style={[styles.msgName, { color: nameColor }]}>
          {prefix}{msg.displayName}
        </Text>
        <Text style={styles.msgTimestamp}>{formatRelativeTime(msg.createdAtMs)}</Text>
      </View>
      <Text style={styles.msgBody}>{msg.body}</Text>
      {sortedReactions.length > 0 && (
        <View style={styles.reactionsRow}>
          {sortedReactions.map(([emoji, count]) => (
            <TouchableOpacity
              key={emoji}
              style={styles.reactionPill}
              onPress={() => onReact(msg.id, emoji)}
              activeOpacity={0.7}
            >
              <Text style={styles.reactionPillText}>
                {emoji} {count}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </Pressable>
  );
});

// ── Main component ────────────────────────────────────────────────────────────

interface ChatPanelProps {
  visible: boolean;
  onClose: () => void;
  token?: string | null;
}

export function ChatPanel({ visible, onClose, token }: ChatPanelProps) {
  const c = useColors();
  const {
    state,
    messages,
    viewers,
    identity,
    settings,
    pinnedMessage,
    lastAckAtMs,
    send,
    react,
    reconnect,
  } = useChat({ channelId: LIVE_CHANNEL_ID, token });

  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isPinDismissed, setIsPinDismissed] = useState(false);
  const [slowRemaining, setSlowRemaining] = useState(0);
  // Client-side block list — hides messages from blocked users for this session
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set());

  const listRef = useRef<FlatList>(null);
  const isAtBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const lastPinnedIdRef = useRef<string | undefined>(undefined);
  const inputRef = useRef<TextInput>(null);

  // Reset pin-dismissed flag when a new message is pinned
  useEffect(() => {
    if (pinnedMessage?.id !== lastPinnedIdRef.current) {
      lastPinnedIdRef.current = pinnedMessage?.id;
      setIsPinDismissed(false);
    }
  }, [pinnedMessage?.id]);

  // Auto-scroll + unread counter
  useEffect(() => {
    const delta = messages.length - prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (delta <= 0 || !visible) return;
    if (isAtBottomRef.current) {
      listRef.current?.scrollToEnd({ animated: true });
    } else {
      setUnreadCount((n) => n + delta);
    }
  }, [messages.length, visible]);

  // Slow-mode countdown tick
  useEffect(() => {
    const secs = settings?.slowModeSecs ?? 0;
    if (secs <= 0 || identity?.isModerator) {
      setSlowRemaining(0);
      return;
    }
    const tick = () => {
      const elapsed = (Date.now() - lastAckAtMs) / 1000;
      return Math.max(0, Math.ceil(secs - elapsed));
    };
    setSlowRemaining(tick());
    const iv = setInterval(() => {
      const rem = tick();
      setSlowRemaining(rem);
      if (rem === 0) clearInterval(iv);
    }, 500);
    return () => clearInterval(iv);
  }, [settings?.slowModeSecs, lastAckAtMs, identity?.isModerator]);

  const handleScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number }; layoutMeasurement: { height: number }; contentSize: { height: number } } }) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    const distFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const atBottom = distFromBottom < SCROLL_NEAR_BOTTOM_PX;
    if (atBottom && !isAtBottomRef.current) setUnreadCount(0);
    isAtBottomRef.current = atBottom;
  }, []);

  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
    setUnreadCount(0);
    isAtBottomRef.current = true;
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || slowRemaining > 0) return;
    send(trimmed);
    setText("");
    setShowEmoji(false);
  }, [text, send, slowRemaining]);

  const handleEmojiPress = useCallback((emoji: string) => {
    setText((t) => t + emoji);
    inputRef.current?.focus();
  }, []);

  const handleReact = useCallback(
    (messageId: string, emoji: string) => { react(messageId, emoji); },
    [react],
  );

  const handleLongPress = useCallback(
    (msg: ChatMessage) => {
      const isMod = identity?.isModerator ?? false;
      const isOwnMsg = identity?.sessionId === msg.userId;

      const options: Array<{ text: string; style?: "cancel" | "destructive"; onPress?: () => void }> = [];

      if (!isOwnMsg) {
        options.push({
          text: "Report Message",
          onPress: () => {
            void apiModAction(`/api/v1/chat/messages/${msg.id}/report`, "POST", token);
            Alert.alert("Reported", "Thank you — our team will review this message.");
          },
        });
        options.push({
          text: "Block User",
          style: "destructive",
          onPress: () => {
            if (msg.userId) {
              setBlockedUserIds((prev) => {
                const next = new Set(prev);
                next.add(msg.userId!);
                return next;
              });
            }
          },
        });
      }

      if (isMod) {
        options.push({
          text: "Delete Message",
          style: "destructive",
          onPress: () => {
            void apiModAction(`/api/v1/chat/messages/${msg.id}`, "DELETE", token);
          },
        });
        if (msg.userId) {
          options.push({
            text: "Mute User (1 h)",
            style: "destructive",
            onPress: () => {
              void apiModAction(
                `/api/v1/chat/users/${msg.userId}/mute`,
                "POST",
                token,
              );
            },
          });
        }
      }

      options.push({ text: "Cancel", style: "cancel" });

      Alert.alert(
        isMod ? "Moderation" : "Message Options",
        `"${msg.displayName}": ${msg.body.slice(0, 60)}${msg.body.length > 60 ? "…" : ""}`,
        options,
      );
    },
    [identity, token],
  );

  const isModerator = identity?.isModerator ?? false;

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageRow
        msg={item}
        onReact={handleReact}
        onLongPress={handleLongPress}
        isModerator={isModerator}
      />
    ),
    [handleReact, handleLongPress, isModerator],
  );

  const keyExtractor = useCallback((m: ChatMessage) => m.id, []);

  // Filter client-side blocked users
  const visibleMessages = useMemo(
    () => messages.filter((m) => !m.userId || !blockedUserIds.has(m.userId)),
    [messages, blockedUserIds],
  );

  const isSendDisabled = !text.trim() || slowRemaining > 0;
  const showPinBanner = !!pinnedMessage && !isPinDismissed;
  const isSubscriberOnly = settings?.subscriberOnly && !identity;

  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <KeyboardAvoidingView
        style={styles.panel}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Live Chat</Text>
            {viewers > 0 && (
              <View style={styles.viewerPill}>
                <Feather name="users" size={10} color="rgba(255,255,255,0.6)" />
                <Text style={styles.viewerCount}>{viewers.toLocaleString()}</Text>
              </View>
            )}
          </View>
          <View style={styles.headerRight}>
            <ConnectionBadge state={state} onRetry={reconnect} />
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color="rgba(255,255,255,0.7)" />
            </Pressable>
          </View>
        </View>

        {/* ── Pinned message banner ────────────────────────────────────────── */}
        {showPinBanner && (
          <View style={styles.pinnedBanner}>
            <Feather name="bookmark" size={11} color="#f59e0b" />
            <Text style={styles.pinnedBody} numberOfLines={1}>
              {pinnedMessage!.body}
            </Text>
            <TouchableOpacity
              onPress={() => setIsPinDismissed(true)}
              hitSlop={8}
            >
              <Feather name="x" size={12} color="rgba(255,255,255,0.4)" />
            </TouchableOpacity>
          </View>
        )}

        {/* ── Subscriber-only notice ───────────────────────────────────────── */}
        {isSubscriberOnly && (
          <View style={styles.subscriberBanner}>
            <Feather name="lock" size={12} color="#a855f7" />
            <Text style={styles.subscriberText}>
              Members only — sign in to chat
            </Text>
          </View>
        )}

        {/* ── Messages ────────────────────────────────────────────────────── */}
        <View style={styles.listContainer}>
          {visibleMessages.length === 0 ? (
            <View style={styles.empty}>
              <Feather
                name="message-circle"
                size={28}
                color="rgba(255,255,255,0.2)"
              />
              <Text style={styles.emptyText}>
                {state === "open"
                  ? "Be the first to say something!"
                  : state === "closed"
                    ? "Chat unavailable"
                    : "Connecting to chat…"}
              </Text>
              {state === "closed" && (
                <TouchableOpacity
                  style={styles.emptyRetryBtn}
                  onPress={reconnect}
                  activeOpacity={0.7}
                >
                  <Feather name="refresh-cw" size={13} color="#a855f7" />
                  <Text style={styles.emptyRetryText}>Tap to reconnect</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={visibleMessages}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={100}
              maxToRenderPerBatch={10}
              updateCellsBatchingPeriod={50}
              windowSize={11}
              initialNumToRender={20}
              removeClippedSubviews={Platform.OS !== "ios"}
              onContentSizeChange={() => {
                if (isAtBottomRef.current) {
                  listRef.current?.scrollToEnd({ animated: false });
                }
              }}
            />
          )}

          {/* ── "↓ N new" pill ─────────────────────────────────────────── */}
          {unreadCount > 0 && (
            <TouchableOpacity
              style={styles.newMsgPill}
              onPress={scrollToBottom}
              activeOpacity={0.8}
            >
              <Feather name="arrow-down" size={11} color="#fff" />
              <Text style={styles.newMsgText}>
                {unreadCount > 99 ? "99+" : unreadCount} new
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Emoji quick-access tray ──────────────────────────────────────── */}
        {showEmoji && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.emojiTray}
            contentContainerStyle={styles.emojiTrayContent}
            keyboardShouldPersistTaps="always"
          >
            {QUICK_EMOJIS.map((e) => (
              <TouchableOpacity
                key={e}
                onPress={() => handleEmojiPress(e)}
                style={styles.emojiBtn}
                activeOpacity={0.7}
              >
                <Text style={styles.emojiText}>{e}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* ── Input row ────────────────────────────────────────────────────── */}
        <View style={styles.inputRow}>
          {/* Emoji toggle */}
          <TouchableOpacity
            onPress={() => setShowEmoji((v) => !v)}
            style={styles.emojiToggle}
            activeOpacity={0.7}
          >
            <Text style={styles.emojiToggleIcon}>
              {showEmoji ? "⌨️" : "😊"}
            </Text>
          </TouchableOpacity>

          <View style={styles.inputWrap}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={
                settings?.subscriberOnly && !identity
                  ? "Sign in to chat…"
                  : "Say something…"
              }
              placeholderTextColor="rgba(255,255,255,0.3)"
              returnKeyType="send"
              onSubmitEditing={handleSend}
              maxLength={500}
              multiline={false}
              editable={!isSubscriberOnly}
              accessibilityLabel="Chat message input"
            />
            {/* Slow-mode indicator */}
            {slowRemaining > 0 && (
              <View style={styles.slowBadge}>
                <Text style={styles.slowText}>⏱ {slowRemaining}s</Text>
              </View>
            )}
          </View>

          <Pressable
            onPress={handleSend}
            disabled={isSendDisabled}
            style={({ pressed }) => [
              styles.sendBtn,
              {
                backgroundColor: !isSendDisabled
                  ? c.primary
                  : "rgba(255,255,255,0.08)",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: isSendDisabled }}
          >
            <Feather
              name="send"
              size={16}
              color={!isSendDisabled ? "#fff" : "rgba(255,255,255,0.3)"}
            />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    top: "40%",
    zIndex: 50,
  },
  panel: {
    flex: 1,
    backgroundColor: "rgba(10,0,20,0.92)",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: "rgba(168,85,247,0.3)",
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.07)",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerTitle: { color: "#fff", fontWeight: "700", fontSize: 15 },
  viewerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
  },
  viewerCount: { color: "rgba(255,255,255,0.6)", fontSize: 11 },
  badge: { flexDirection: "row", alignItems: "center", gap: 5 },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  closeBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },

  // Pinned banner
  pinnedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: "rgba(245,158,11,0.12)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(245,158,11,0.2)",
  },
  pinnedBody: {
    flex: 1,
    color: "rgba(255,255,255,0.85)",
    fontSize: 12,
  },

  // Subscriber-only banner
  subscriberBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: "rgba(168,85,247,0.12)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(168,85,247,0.2)",
  },
  subscriberText: { color: "rgba(255,255,255,0.7)", fontSize: 12 },

  // List
  listContainer: { flex: 1, position: "relative" },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 6,
  },

  // Messages
  msgRow: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderLeftWidth: 0,
    borderRadius: 4,
  },
  msgRowHighlighted: {
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
    paddingLeft: 8,
    backgroundColor: "rgba(245,158,11,0.06)",
    borderRadius: 4,
    marginVertical: 1,
  },
  msgRowPressed: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  msgHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginBottom: 1,
  },
  msgName: {
    fontSize: 12,
    fontWeight: "600",
    flexShrink: 1,
  },
  msgTimestamp: {
    fontSize: 10,
    color: "rgba(255,255,255,0.28)",
  },
  msgBody: {
    fontSize: 13,
    lineHeight: 18,
    color: "rgba(255,255,255,0.85)",
    flexWrap: "wrap",
  },

  // Reactions
  reactionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 3,
  },
  reactionPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 12,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  reactionPillText: { fontSize: 12, color: "rgba(255,255,255,0.8)" },

  // Unread pill
  newMsgPill: {
    position: "absolute",
    bottom: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(168,85,247,0.85)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 4,
  },
  newMsgText: { color: "#fff", fontSize: 12, fontWeight: "600" },

  // Empty state
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    opacity: 0.6,
  },
  emptyText: {
    fontSize: 14,
    color: "rgba(255,255,255,0.5)",
    textAlign: "center",
  },
  emptyRetryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(168,85,247,0.4)",
    backgroundColor: "rgba(168,85,247,0.1)",
  },
  emptyRetryText: {
    color: "#a855f7",
    fontSize: 13,
    fontWeight: "600",
  },

  // Connection retry button (in header)
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "rgba(239,68,68,0.12)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.3)",
  },
  retryText: {
    fontSize: 10,
    color: "#ef4444",
    fontWeight: "600",
  },

  // Emoji tray
  emojiTray: {
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.07)",
    maxHeight: 44,
  },
  emojiTrayContent: {
    paddingHorizontal: 10,
    alignItems: "center",
    gap: 2,
  },
  emojiBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiText: { fontSize: 22 },

  // Input row
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.07)",
  },
  emojiToggle: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiToggleIcon: { fontSize: 20 },
  inputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
    paddingVertical: 8,
    color: "#fff",
    fontSize: 14,
  },
  slowBadge: {
    backgroundColor: "rgba(245,158,11,0.2)",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  slowText: { color: "#f59e0b", fontSize: 11, fontWeight: "600" },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
});
