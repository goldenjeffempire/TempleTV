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

/**
 * Execute a moderation REST call and return whether it succeeded.
 * Callers decide whether to surface failures to the user — destructive
 * actions (delete, mute) always show an alert on failure so moderators
 * know their action didn't land; report/block are silent best-effort.
 */
async function apiModAction(
  path: string,
  method: "POST" | "DELETE",
  token?: string | null,
): Promise<boolean> {
  const base = getApiBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    return res.ok;
  } catch {
    return false;
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
  /** Bumped every 30 s so relative timestamps ("just now" → "2m") stay fresh
   *  even when the message object itself hasn't changed. React.memo compares
   *  props by reference, so without this the cell would never re-render and
   *  "just now" would persist for the entire session. */
  clockTick: number;
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
  /**
   * When true, render as an inline flex container (fills the parent's
   * remaining space) instead of an absolute-positioned floating overlay.
   * Used by the live broadcast split-screen layout so chat is always visible
   * below the player without covering the video.
   */
  inline?: boolean;
}

export function ChatPanel({ visible, onClose, token, inline = false }: ChatPanelProps) {
  const c = useColors();
  const {
    state,
    messages,
    pending,
    viewers,
    identity,
    settings,
    pinnedMessage,
    lastAckAtMs,
    lastError,
    typingUsers,
    send,
    react,
    reconnect,
    sendTyping,
  } = useChat({ channelId: LIVE_CHANNEL_ID, token });

  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isPinDismissed, setIsPinDismissed] = useState(false);
  const [slowRemaining, setSlowRemaining] = useState(0);
  // Client-side block list — hides messages from blocked users.
  // Persisted to AsyncStorage so it survives app restarts.
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set());
  // Clock tick every 30 s — busts React.memo on MessageRow so relative
  // timestamps ("just now" → "2m" → "1h") update throughout a live session.
  const [clockTick, setClockTick] = useState(0);
  // Error toast — surfaced when the server rejects a send (rate_limited, muted,
  // banned, duplicate, etc.). Auto-dismissed after 4 s for transient errors.
  const [errorToastMsg, setErrorToastMsg] = useState<string | null>(null);
  const errorToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Typing debounce — fires sendTyping(true) after the first keystroke and
  // sendTyping(false) after 2 s of inactivity (or on send).
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

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

  // ── Clock tick for timestamp refresh ────────────────────────────────────────
  // Increments every 30 s so MessageRow (React.memo'd) re-renders its relative
  // timestamp: "just now" → "1m" → "2m" etc. Without this, memo prevents any
  // re-render and the displayed timestamp never advances.
  useEffect(() => {
    const iv = setInterval(() => setClockTick((t) => t + 1), 30_000);
    return () => clearInterval(iv);
  }, []);

  // ── Block list persistence ───────────────────────────────────────────────────
  // Load persisted blocks from AsyncStorage on first mount so the list survives
  // app restarts. Save whenever the set changes (write is async, fire-and-forget).
  const BLOCKED_USERS_KEY = "@templetv/chat_blocked_users";
  useEffect(() => {
    void (async () => {
      try {
        const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
        const raw = await AsyncStorage.getItem(BLOCKED_USERS_KEY);
        if (raw) {
          const ids: string[] = JSON.parse(raw);
          if (ids.length > 0) setBlockedUserIds(new Set(ids));
        }
      } catch { /* ignore corrupt/missing storage on first launch */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (blockedUserIds.size === 0) return;
    void (async () => {
      try {
        const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
        await AsyncStorage.setItem(BLOCKED_USERS_KEY, JSON.stringify([...blockedUserIds]));
      } catch { /* storage write failure is non-fatal */ }
    })();
  }, [blockedUserIds]);

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

  // Error toast: show server error messages to the user; auto-dismiss
  // transient errors (rate limited, duplicate, etc.) after 4 s.
  useEffect(() => {
    if (!lastError) return;
    const isPersistent =
      lastError.code === "muted" ||
      lastError.code === "banned" ||
      lastError.code === "blocked";
    setErrorToastMsg(lastError.message);
    if (!isPersistent) {
      if (errorToastTimerRef.current) clearTimeout(errorToastTimerRef.current);
      errorToastTimerRef.current = setTimeout(() => {
        setErrorToastMsg(null);
      }, 4_000);
    }
    return () => {
      if (errorToastTimerRef.current) {
        clearTimeout(errorToastTimerRef.current);
        errorToastTimerRef.current = null;
      }
    };
  }, [lastError]);

  // Clean up typing + error timers on unmount
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (errorToastTimerRef.current) clearTimeout(errorToastTimerRef.current);
      // Notify server we stopped typing
      sendTyping(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleTextChange = useCallback((val: string) => {
    setText(val);
    // Typing indicator: notify server user is typing (debounced)
    if (val.trim()) {
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        sendTyping(true);
      }
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        isTypingRef.current = false;
        sendTyping(false);
        typingTimerRef.current = null;
      }, 2_000);
    } else {
      if (isTypingRef.current) {
        isTypingRef.current = false;
        sendTyping(false);
      }
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    }
  }, [sendTyping]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || slowRemaining > 0) return;
    // Clear typing state immediately on send
    if (isTypingRef.current) {
      isTypingRef.current = false;
      sendTyping(false);
    }
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    send(trimmed);
    setText("");
    setShowEmoji(false);
  }, [text, send, slowRemaining, sendTyping]);

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
      // Compare via userId (authenticated) with sessionId fallback for guests.
      // This prevents users from seeing report/block options on their own messages.
      const myUserId = identity?.userId ?? null;
      const isOwnMsg =
        (myUserId !== null && myUserId === msg.userId) ||
        (myUserId === null && identity?.sessionId === msg.userId);

      const options: Array<{ text: string; style?: "cancel" | "destructive"; onPress?: () => void }> = [];

      if (!isOwnMsg) {
        options.push({
          text: "Report Message",
          onPress: () => {
            if (!token) {
              // Unauthenticated — give a truthful message instead of silently failing.
              Alert.alert(
                "Sign In Required",
                "Please sign in to report messages. This helps us verify reports and prevent abuse.",
              );
              return;
            }
            void (async () => {
              try {
                const base = getApiBase();
                if (!base) throw new Error("no api base");
                const res = await fetch(`${base}/api/v1/chat/messages/${msg.id}/report`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({}),
                });
                if (res.status === 401) {
                  Alert.alert(
                    "Sign In Required",
                    "Please sign in to report messages.",
                  );
                } else if (res.status === 409) {
                  Alert.alert("Already Reported", "You have already reported this message.");
                } else if (res.ok) {
                  Alert.alert("Reported", "Thank you — our team will review this message.");
                } else {
                  const data = await res.json().catch(() => ({})) as { error?: string };
                  Alert.alert("Report Failed", data.error ?? "Could not submit report. Please try again.");
                }
              } catch {
                Alert.alert("Report Failed", "Could not submit report. Please check your connection.");
              }
            })();
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
              // Confirmation so the user knows it worked (and that it persists).
              Alert.alert(
                "User Blocked",
                `You won't see messages from ${msg.displayName} anymore. This applies on this device.`,
              );
            }
          },
        });
      }

      if (isMod) {
        options.push({
          text: "Delete Message",
          style: "destructive",
          onPress: () => {
            // Moderators need to know if the action failed — a silent no-op
            // looks identical to success and erodes trust in the tool.
            void apiModAction(`/api/v1/chat/messages/${msg.id}`, "DELETE", token).then((ok) => {
              if (!ok) {
                Alert.alert(
                  "Action Failed",
                  "Could not delete the message. You may not have permission, or the message may already be gone.",
                );
              }
            });
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
              ).then((ok) => {
                if (ok) {
                  Alert.alert("User Muted", `${msg.displayName} has been muted for 1 hour.`);
                } else {
                  Alert.alert(
                    "Action Failed",
                    "Could not mute this user. Please try again or check your moderator permissions.",
                  );
                }
              });
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
        clockTick={clockTick}
      />
    ),
    [handleReact, handleLongPress, isModerator, clockTick],
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
  // Client-side send failures (e.g. "Not connected — reconnecting…")
  // Shown above the input so the user can tap to retry.
  const failedMessages = useMemo(
    () => pending.filter((p) => p.status === "error"),
    [pending],
  );

  if (!visible) return null;

  // Inline mode: renders as a flex child filling the parent container.
  // Floating mode: renders as an absolute-positioned overlay (original behaviour).
  if (inline) {
    return (
      <KeyboardAvoidingView
        style={styles.inlinePanel}
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
            {/* No close button in inline mode — the chat panel is always present */}
          </View>
        </View>

        {/* ── Pinned message banner ────────────────────────────────────────── */}
        {showPinBanner && (
          <View style={styles.pinnedBanner}>
            <Feather name="bookmark" size={11} color="#f59e0b" />
            <Text style={styles.pinnedBody} numberOfLines={1}>
              {pinnedMessage!.body}
            </Text>
            <TouchableOpacity onPress={() => setIsPinDismissed(true)} hitSlop={8}>
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
              <Feather name="message-circle" size={28} color="rgba(255,255,255,0.2)" />
              <Text style={styles.emptyText}>
                {state === "open"
                  ? "Be the first to say something!"
                  : state === "closed"
                    ? "Chat unavailable"
                    : "Connecting to chat…"}
              </Text>
              {state === "closed" && (
                <TouchableOpacity style={styles.emptyRetryBtn} onPress={reconnect} activeOpacity={0.7}>
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
          {unreadCount > 0 && (
            <TouchableOpacity style={styles.newMsgPill} onPress={scrollToBottom} activeOpacity={0.8}>
              <Feather name="arrow-down" size={11} color="#fff" />
              <Text style={styles.newMsgText}>
                {unreadCount > 99 ? "99+" : unreadCount} new
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Emoji tray ───────────────────────────────────────────────────── */}
        {showEmoji && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.emojiTray}
            contentContainerStyle={styles.emojiTrayContent}
            keyboardShouldPersistTaps="always"
          >
            {QUICK_EMOJIS.map((e) => (
              <TouchableOpacity key={e} onPress={() => handleEmojiPress(e)} style={styles.emojiBtn} activeOpacity={0.7}>
                <Text style={styles.emojiText}>{e}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* ── Typing indicator ─────────────────────────────────────────── */}
        {typingUsers.length > 0 && (
          <View style={styles.typingRow} accessibilityLiveRegion="polite">
            <Text style={styles.typingText}>
              {typingUsers.length === 1
                ? `${typingUsers[0]!.displayName} is typing…`
                : typingUsers.length === 2
                ? `${typingUsers[0]!.displayName} and ${typingUsers[1]!.displayName} are typing…`
                : "Several people are typing…"}
            </Text>
          </View>
        )}

        {/* ── Error toast ──────────────────────────────────────────────── */}
        {errorToastMsg && (
          <Pressable
            style={styles.errorToast}
            onPress={() => setErrorToastMsg(null)}
            accessibilityRole="alert"
            accessibilityLabel={`Chat error: ${errorToastMsg}. Tap to dismiss.`}
          >
            <Feather name="alert-circle" size={12} color="#fca5a5" />
            <Text style={styles.errorToastText} numberOfLines={2}>{errorToastMsg}</Text>
            <Feather name="x" size={12} color="rgba(255,255,255,0.4)" />
          </Pressable>
        )}

        {/* ── Input row ─────────────────────────────────────────────────── */}
        <View style={styles.inputRow}>
          <TouchableOpacity
            onPress={() => setShowEmoji((v) => !v)}
            style={styles.emojiToggle}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={showEmoji ? "Switch to keyboard" : "Open emoji picker"}
          >
            <Text style={styles.emojiToggleIcon}>{showEmoji ? "⌨️" : "😊"}</Text>
          </TouchableOpacity>
          <View style={styles.inputWrap}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={text}
              onChangeText={handleTextChange}
              placeholder={settings?.subscriberOnly && !identity ? "Sign in to chat…" : "Say something…"}
              placeholderTextColor="rgba(255,255,255,0.3)"
              returnKeyType="send"
              onSubmitEditing={handleSend}
              maxLength={500}
              multiline={false}
              editable={!isSubscriberOnly}
              accessibilityLabel="Chat message input"
              accessibilityHint="Type a message and press send or return"
            />
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
                backgroundColor: !isSendDisabled ? c.primary : "rgba(255,255,255,0.08)",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: isSendDisabled }}
          >
            <Feather name="send" size={16} color={!isSendDisabled ? "#fff" : "rgba(255,255,255,0.3)"} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

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
        {/* ── Typing indicator ────────────────────────────────────────────── */}
        {typingUsers.length > 0 && (
          <View style={styles.typingRow} accessibilityLiveRegion="polite">
            <Text style={styles.typingText}>
              {typingUsers.length === 1
                ? `${typingUsers[0]!.displayName} is typing…`
                : typingUsers.length === 2
                ? `${typingUsers[0]!.displayName} and ${typingUsers[1]!.displayName} are typing…`
                : "Several people are typing…"}
            </Text>
          </View>
        )}

        {/* ── Error toast ─────────────────────────────────────────────────── */}
        {errorToastMsg && (
          <Pressable
            style={styles.errorToast}
            onPress={() => setErrorToastMsg(null)}
            accessibilityRole="alert"
            accessibilityLabel={`Chat error: ${errorToastMsg}. Tap to dismiss.`}
          >
            <Feather name="alert-circle" size={12} color="#fca5a5" />
            <Text style={styles.errorToastText} numberOfLines={2}>{errorToastMsg}</Text>
            <Feather name="x" size={12} color="rgba(255,255,255,0.4)" />
          </Pressable>
        )}

        <View style={styles.inputRow}>
          {/* Emoji toggle */}
          <TouchableOpacity
            onPress={() => setShowEmoji((v) => !v)}
            style={styles.emojiToggle}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={showEmoji ? "Switch to keyboard" : "Open emoji picker"}
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
              onChangeText={handleTextChange}
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
              accessibilityHint="Type a message and press send or return"
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
  // Inline variant: fills parent flex space (no absolute overlay)
  inlinePanel: {
    flex: 1,
    backgroundColor: "rgba(10,0,20,0.98)",
    borderTopWidth: 1,
    borderTopColor: "rgba(168,85,247,0.25)",
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
  typingRow: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  typingText: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 11,
    fontStyle: "italic",
  },
  errorToast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 8,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "rgba(239,68,68,0.15)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.3)",
  },
  errorToastText: {
    flex: 1,
    color: "#fca5a5",
    fontSize: 12,
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
