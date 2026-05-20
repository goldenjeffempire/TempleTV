import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { ReactionType } from "@/services/broadcast";

/**
 * Sticky live-interaction bar pinned to the bottom of the broadcast surface.
 *
 * Six segments — Live · Viewers · Reactions · Chat · Prayer · Share — that
 * stay visible during playback without occluding the video. Tapping a
 * segment either fires its native action (Reactions cycles a reaction
 * burst, Share invokes the platform share sheet) or opens the expandable
 * `BroadcastLiveSheet` to the matching tab.
 *
 * Designed as a thin "always-on" surface (~64px) so it works on phone
 * portrait, tablet, and the centered desktop column without competing
 * with the player chrome. The bar sits ABOVE the safe-area inset; the
 * caller is responsible for inset padding so the touch targets clear
 * the home-indicator on iOS / gesture pill on Android.
 *
 * Visual language matches the slate-dark cinematic player theme
 * (`#0d1117` family) documented in replit.md so it reads as one
 * continuous broadcast surface, not a tacked-on toolbar.
 */

export type LiveBarTab = "chat" | "prayer" | "schedule" | "donate" | "settings";

interface Props {
  /** Live viewer count from the stream-health SSE channel. `null` until first frame arrives. */
  viewers: number | null;
  /** True while the underlying broadcast is on-air (drives the LIVE pulse). */
  isLive: boolean;
  /** Tap a segment that opens the sheet — caller decides snap height + active tab. */
  onOpenSheet: (tab: LiveBarTab) => void;
  /** Tap REACTIONS — caller fires the emoji burst + posts to the broadcast. */
  onSendReaction: (type: ReactionType) => void;
  /** Tap SHARE — caller invokes Share API. */
  onShare: () => void;
  /** Optional pulse trigger: when this number changes, the reactions icon flashes. */
  reactionPulseKey?: number;
}

const REACTION_CYCLE: ReactionType[] = ["amen", "fire", "hallelujah"];

export function BroadcastLiveBar({
  viewers,
  isLive,
  onOpenSheet,
  onSendReaction,
  onShare,
  reactionPulseKey,
}: Props) {
  // ── LIVE dot pulse ──
  const livePulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isLive) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 0.4, duration: 900, useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isLive, livePulse]);

  // ── Reactions tap burst (icon scale) ──
  const reactScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reactionPulseKey === undefined) return;
    Animated.sequence([
      Animated.timing(reactScale, { toValue: 1.35, duration: 140, useNativeDriver: true }),
      Animated.spring(reactScale, { toValue: 1, friction: 4, useNativeDriver: true }),
    ]).start();
  }, [reactionPulseKey, reactScale]);

  // ── Reaction cycle: each tap rotates Amen → Fire → Hallelujah ──
  const reactionIdxRef = useRef(0);
  const handleReact = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = REACTION_CYCLE[reactionIdxRef.current % REACTION_CYCLE.length];
    reactionIdxRef.current += 1;
    onSendReaction(next);
  };

  const handleTab = (tab: LiveBarTab) => {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    onOpenSheet(tab);
  };

  const handleShare = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onShare();
  };

  // Viewers display: 1.2k formatting at >=1000 so the segment never wraps.
  const viewersLabel =
    viewers === null
      ? "—"
      : viewers >= 1000
        ? `${(viewers / 1000).toFixed(viewers >= 10000 ? 0 : 1)}k`
        : String(viewers);

  return (
    <View style={styles.outer}>
      {/* Drag handle hint — visual only; the real swipe-up gesture is owned
          by the parent <BroadcastLiveSheet> backdrop area so the bar can
          stay simple-tap. */}
      <View style={styles.handleRow}>
        <View style={styles.handle} />
      </View>

      <View style={styles.bar}>
        {/* LIVE */}
        <Pressable
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          onPress={() => handleTab("schedule")}
          accessibilityRole="button"
          accessibilityLabel="Live status — open program schedule"
        >
          <Animated.View
            style={[
              styles.liveDot,
              { opacity: isLive ? livePulse : 0.4, backgroundColor: isLive ? "#FF0040" : "#666" },
            ]}
          />
          <Text style={[styles.segmentLabel, isLive && styles.segmentLabelLive]}>
            {isLive ? "LIVE" : "OFF"}
          </Text>
        </Pressable>

        {/* VIEWERS */}
        <Pressable
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          onPress={() => handleTab("schedule")}
          accessibilityRole="button"
          accessibilityLabel={`${viewers ?? "Unknown"} viewers watching now`}
        >
          <Feather name="users" size={16} color="#E6EDF3" />
          <Text style={styles.segmentLabel}>{viewersLabel}</Text>
        </Pressable>

        {/* REACTIONS */}
        <Pressable
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          onPress={handleReact}
          accessibilityRole="button"
          accessibilityLabel="Send a reaction"
        >
          <Animated.View style={{ transform: [{ scale: reactScale }] }}>
            <Feather name="heart" size={16} color="#FF6B9D" />
          </Animated.View>
          <Text style={styles.segmentLabel}>React</Text>
        </Pressable>

        {/* CHAT */}
        <Pressable
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          onPress={() => handleTab("chat")}
          accessibilityRole="button"
          accessibilityLabel="Open live chat"
        >
          <Feather name="message-circle" size={16} color="#E6EDF3" />
          <Text style={styles.segmentLabel}>Chat</Text>
        </Pressable>

        {/* PRAYER */}
        <Pressable
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          onPress={() => handleTab("prayer")}
          accessibilityRole="button"
          accessibilityLabel="Submit a prayer request"
        >
          <Text style={styles.prayerEmoji}>🙏</Text>
          <Text style={styles.segmentLabel}>Prayer</Text>
        </Pressable>

        {/* SHARE */}
        <Pressable
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          onPress={handleShare}
          accessibilityRole="button"
          accessibilityLabel="Share this broadcast"
        >
          <Feather name="share-2" size={16} color="#E6EDF3" />
          <Text style={styles.segmentLabel}>Share</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    backgroundColor: "#0d1117",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.08)",
    // Subtle inner top-shadow so the bar reads as a distinct surface above
    // the player even on AMOLED panels where pure-dark blends into pure-dark.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 12,
  },
  handleRow: {
    alignItems: "center",
    paddingTop: 6,
    paddingBottom: 2,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 8,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 6,
    paddingHorizontal: 2,
    borderRadius: 10,
    minHeight: 48,
  },
  segmentPressed: {
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  segmentLabel: {
    color: "#C9D1D9",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  segmentLabelLive: {
    color: "#FF0040",
    fontWeight: "800",
    letterSpacing: 1.0,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    shadowColor: "#FF0040",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
  },
  prayerEmoji: {
    fontSize: 16,
    lineHeight: 18,
  },
});
