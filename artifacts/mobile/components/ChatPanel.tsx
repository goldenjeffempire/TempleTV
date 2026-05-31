/**
 * Live chat overlay panel for the mobile player.
 *
 * Renders a translucent chat panel that slides up over the player when live.
 * Uses the existing `useChat` hook backed by `ChatClient` (WebSocket).
 *
 * Design:
 *  • Glassmorphic dark panel, 60% of screen height
 *  • Scrollable messages list, newest at bottom
 *  • Input bar with Send button
 *  • Connection state badge (connecting / live / offline)
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useChat } from "@/lib/chat/useChat";
import type { ChatMessage } from "@/lib/chat/types";
import { useColors } from "@/hooks/useColors";

// Default live channel ID used by the Temple TV broadcast
const LIVE_CHANNEL_ID = "temple-tv-live";

interface ChatPanelProps {
  visible: boolean;
  onClose: () => void;
}

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

function MessageRow({ msg }: { msg: ChatMessage }) {
  const isSystem = !msg.userId;
  return (
    <View style={styles.msgRow}>
      <Text style={[styles.msgName, isSystem && styles.msgNameSystem]}>
        {msg.displayName}
      </Text>
      <Text style={styles.msgBody}>{msg.body}</Text>
    </View>
  );
}

export function ChatPanel({ visible, onClose }: ChatPanelProps) {
  const c = useColors();
  const { state, messages, viewers, send } = useChat({
    channelId: LIVE_CHANNEL_ID,
  });
  const [text, setText] = useState("");
  const listRef = useRef<FlatList>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0 && visible) {
      const t = setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 50);
      return () => clearTimeout(t);
    }
  }, [messages.length, visible]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send(trimmed);
    setText("");
  }, [text, send]);

  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <KeyboardAvoidingView
        style={styles.panel}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* Header */}
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

        {/* Messages */}
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="message-circle" size={28} color="rgba(255,255,255,0.2)" />
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
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <MessageRow msg={item} />}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
          />
        )}

        {/* Input */}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Say something…"
            placeholderTextColor="rgba(255,255,255,0.3)"
            returnKeyType="send"
            onSubmitEditing={handleSend}
            maxLength={500}
            multiline={false}
          />
          <Pressable
            onPress={handleSend}
            disabled={!text.trim()}
            style={({ pressed }) => [
              styles.sendBtn,
              {
                backgroundColor: text.trim() ? c.primary : "rgba(255,255,255,0.08)",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Feather
              name="send"
              size={16}
              color={text.trim() ? "#fff" : "rgba(255,255,255,0.3)"}
            />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
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
  closeBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 8,
  },
  msgRow: { gap: 1 },
  msgName: {
    fontSize: 12,
    fontWeight: "700",
    color: "#a855f7",
  },
  msgNameSystem: { color: "#f59e0b" },
  msgBody: { fontSize: 14, color: "rgba(255,255,255,0.88)", lineHeight: 19 },
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
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.07)",
  },
  input: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: "#fff",
    fontSize: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
});
