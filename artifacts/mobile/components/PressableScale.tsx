/**
 * PressableScale — shared touch-feedback primitive.
 *
 * Gives a short, native-driver scale + opacity response on press. Honours the
 * OS "reduce motion" setting (falls back to opacity only) and never starts a
 * looping animation — each press runs one finite spring.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  Platform,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { createReducedMotionStore } from "@/lib/reducedMotionStore";

const motionStore = createReducedMotionStore({
  read: () => AccessibilityInfo.isReduceMotionEnabled?.() ?? Promise.resolve(true),
  watch: update => {
    const subscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", update);
    return () => subscription?.remove?.();
  },
});

export function useReducedMotion(): boolean {
  return useSyncExternalStore(motionStore.subscribe, motionStore.getSnapshot, motionStore.getSnapshot);
}

type Props = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  /** Scale reached while pressed (default 0.97). */
  pressedScale?: number;
  children?: React.ReactNode;
};

export function PressableScale({ style, pressedScale = 0.97, children, onPressIn, onPressOut, ...rest }: Props) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const [pressed, setPressed] = useState(false);
  useEffect(() => () => scale.stopAnimation(), [scale]);

  const to = (v: number) => {
    if (reduced) { scale.stopAnimation(); scale.setValue(1); return; }
    Animated.spring(scale, { toValue: v, useNativeDriver: Platform.OS !== "web", speed: 40, bounciness: 0 }).start();
  };

  return (
    <Pressable
      {...rest}
      onPressIn={(e) => { setPressed(true); to(pressedScale); onPressIn?.(e); }}
      onPressOut={(e) => { setPressed(false); to(1); onPressOut?.(e); }}
    >
      <Animated.View style={[style, { transform: [{ scale }], opacity: pressed ? 0.88 : 1 }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
