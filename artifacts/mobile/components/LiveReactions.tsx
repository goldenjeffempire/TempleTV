import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { sendReaction, type ReactionType } from "@/services/broadcast";

const REACTION_CONFIG: { type: ReactionType; emoji: string; label: string }[] = [
  { type: "amen", emoji: "🙏", label: "Amen" },
  { type: "fire", emoji: "🔥", label: "Fire" },
  { type: "hallelujah", emoji: "✨", label: "Glory" },
];

const PARTICLE_DURATION_MS = 1800;
const MAX_ACTIVE_PARTICLES = 20;

interface Particle {
  id: number;
  emoji: string;
  x: number;
  anim: Animated.Value;
}

let particleCounter = 0;

function ReactionParticle({ particle }: { particle: Particle }) {
  return (
    <Animated.Text
      pointerEvents="none"
      style={[
        styles.particle,
        {
          left: particle.x,
          opacity: particle.anim.interpolate({
            inputRange: [0, 0.6, 1],
            outputRange: [0.9, 0.9, 0],
          }),
          transform: [
            {
              translateY: particle.anim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, -160],
              }),
            },
            {
              scale: particle.anim.interpolate({
                inputRange: [0, 0.1, 0.9, 1],
                outputRange: [0.4, 1.2, 1, 0.8],
              }),
            },
          ],
        },
      ]}
    >
      {particle.emoji}
    </Animated.Text>
  );
}

interface LiveReactionsProps {
  latestIncoming?: { type: ReactionType; ts: number } | null;
  containerWidth?: number;
}

export function LiveReactions({ latestIncoming, containerWidth = 320 }: LiveReactionsProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const lastIncomingTs = useRef<number | null>(null);
  const pendingSend = useRef(false);

  const spawnParticle = useCallback((emoji: string, x?: number) => {
    const id = ++particleCounter;
    const safeWidth = Math.max(containerWidth - 80, 60);
    const px = x !== undefined ? x : Math.floor(Math.random() * safeWidth) + 20;
    const anim = new Animated.Value(0);

    setParticles((prev) => {
      const next = [...prev, { id, emoji, x: px, anim }];
      return next.length > MAX_ACTIVE_PARTICLES ? next.slice(-MAX_ACTIVE_PARTICLES) : next;
    });

    Animated.timing(anim, {
      toValue: 1,
      duration: PARTICLE_DURATION_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    }).start(() => {
      setParticles((prev) => prev.filter((p) => p.id !== id));
    });
  }, [containerWidth]);

  useEffect(() => {
    if (!latestIncoming) return;
    if (lastIncomingTs.current === latestIncoming.ts) return;
    lastIncomingTs.current = latestIncoming.ts;
    const cfg = REACTION_CONFIG.find((r) => r.type === latestIncoming.type);
    if (cfg) spawnParticle(cfg.emoji);
  }, [latestIncoming, spawnParticle]);

  const handlePress = useCallback(async (type: ReactionType, emoji: string, btnX: number) => {
    if (pendingSend.current) return;
    pendingSend.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    spawnParticle(emoji, btnX);
    await sendReaction(type);
    setTimeout(() => { pendingSend.current = false; }, 400);
  }, [spawnParticle]);

  return (
    <View style={styles.container} pointerEvents="box-none">
      {particles.map((p) => (
        <ReactionParticle key={p.id} particle={p} />
      ))}

      <View style={styles.buttonRow}>
        {REACTION_CONFIG.map((cfg, i) => {
          const btnX = 28 + i * 88;
          return (
            <Pressable
              key={cfg.type}
              onPress={() => handlePress(cfg.type, cfg.emoji, btnX)}
              style={({ pressed }) => [styles.reactionBtn, { opacity: pressed ? 0.75 : 1 }]}
              accessibilityLabel={cfg.label}
              accessibilityRole="button"
            >
              <Text style={styles.reactionEmoji}>{cfg.emoji}</Text>
              <Text style={styles.reactionLabel}>{cfg.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    height: 180,
    justifyContent: "flex-end",
    overflow: "hidden",
    position: "relative",
  },
  particle: {
    position: "absolute",
    bottom: 52,
    fontSize: 28,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  reactionBtn: {
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
    minWidth: 72,
  },
  reactionEmoji: {
    fontSize: 24,
  },
  reactionLabel: {
    fontSize: 11,
    color: "rgba(255,255,255,0.85)",
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
  },
});
