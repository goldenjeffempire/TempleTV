/**
 * FloatingReactions — animated emoji that float upward during live broadcasts.
 *
 * Usage:
 *   const ref = useRef<FloatingReactionsHandle>(null);
 *   <FloatingReactions ref={ref} />
 *   ref.current?.emit("🙏");
 *
 * Each emitted emoji gets a randomized horizontal offset, scale, and fade
 * animation that runs for ~1.8 s before cleaning itself up. Up to 20
 * particles are rendered simultaneously — oldest are evicted when that
 * limit is exceeded.
 */

import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Animated, StyleSheet, View } from "react-native";

const MAX_PARTICLES = 20;
const ANIM_DURATION_MS = 1800;

interface Particle {
  id: string;
  emoji: string;
  x: number;
  opacity: Animated.Value;
  translateY: Animated.Value;
  scale: Animated.Value;
}

export interface FloatingReactionsHandle {
  emit: (emoji: string) => void;
}

export const FloatingReactions = forwardRef<FloatingReactionsHandle, object>(
  (_props, ref) => {
    const [particles, setParticles] = useState<Particle[]>([]);
    const counterRef = useRef(0);

    const emit = useCallback((emoji: string) => {
      const id = `${Date.now()}-${counterRef.current++}`;
      const x = Math.random() * 0.7 + 0.05; // 5% – 75% from left
      const opacity = new Animated.Value(0);
      const translateY = new Animated.Value(0);
      const scale = new Animated.Value(0.4);

      const particle: Particle = { id, emoji, x, opacity, translateY, scale };

      setParticles((prev) => {
        const next = prev.length >= MAX_PARTICLES ? prev.slice(1) : prev;
        return [...next, particle];
      });

      Animated.parallel([
        Animated.sequence([
          Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
          Animated.delay(1000),
          Animated.timing(opacity, { toValue: 0, duration: 600, useNativeDriver: true }),
        ]),
        Animated.timing(translateY, {
          toValue: -220,
          duration: ANIM_DURATION_MS,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.spring(scale, {
            toValue: 1.1,
            friction: 4,
            tension: 160,
            useNativeDriver: true,
          }),
          Animated.timing(scale, { toValue: 0.9, duration: 400, useNativeDriver: true }),
        ]),
      ]).start(() => {
        setParticles((prev) => prev.filter((p) => p.id !== id));
      });
    }, []);

    useImperativeHandle(ref, () => ({ emit }), [emit]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {particles.map((p) => (
          <Animated.Text
            key={p.id}
            style={[
              styles.emoji,
              {
                left: `${Math.round(p.x * 100)}%` as unknown as number,
                opacity: p.opacity,
                transform: [
                  { translateY: p.translateY },
                  { scale: p.scale },
                ],
              },
            ]}
          >
            {p.emoji}
          </Animated.Text>
        ))}
      </View>
    );
  },
);

FloatingReactions.displayName = "FloatingReactions";

const styles = StyleSheet.create({
  emoji: {
    position: "absolute",
    bottom: 80,
    fontSize: 30,
  },
});
