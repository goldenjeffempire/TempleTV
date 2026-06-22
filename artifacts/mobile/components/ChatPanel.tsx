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

// ── Sub-components ────────────────────────────────────────────────────────────

function ConnectionBadge({ state }: { state: string }) {
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
}

const MessageRow = React.memo(function MessageRow({ msg, onReact }: MessageRowProps) {
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
    <View
      style={[
        styles.msgRow,
        msg.isHighlighted && styles.msgRowHighlighted,
      ]}
    >
      <Text style={[styles.msgName, { color: nameColor }]}>
        {prefix}
        {msg.displayName}
        {" "}
        <Text style={styles.msgBody}>{msg.body}</Text>
      </Text>
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
    </View>
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
  } = useChat({ channelId: LIVE_CHANNEL_ID, token });

  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isPinDismissed, setIsPinDismissed] = useState(false);
  const [slowRemaining, setSlowRemaining] = useState(0);

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

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageRow msg={item} onReact={handleReact} />
    ),
    [handleReact],
  );

  const keyExtractor = useCallback((m: ChatMessage) => m.id, []);

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
            <ConnectionBadge state={state} />
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
          {messages.length === 0 ? (
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
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
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
    paddingVertical: 3,
    paddingLeft: 4,
    borderLeftWidth: 0,
  },
  msgRowHighlighted: {
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
    paddingLeft: 8,
    backgroundColor: "rgba(245,158,11,0.06)",
    borderRadius: 4,
    marginVertical: 1,
  },
  msgName: {
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
    flexWrap: "wrap",
  },
  msgBody: {
    fontWeight: "400",
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
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
