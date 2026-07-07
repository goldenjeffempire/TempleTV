import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Animated,
  AppState,
  type AppStateStatus,
  Keyboard,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { LiveBadge } from "@/components/LiveBadge";
import { usePlayer, usePlayerProgress } from "@/context/PlayerContext";
import { navigateToSermon, navigateToPlayer } from "@/utils/navigation";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import { getApiBase } from "@/lib/apiBase";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

// ─── Layout constants ──────────────────────────────────────────────────────────
//
// React Navigation BottomTabBar content-area heights (excluding safe-area
// bottom inset — that is added separately via useSafeAreaInsets().bottom):
//   iOS    → 49pt  (Apple HIG compact bottom bar)
//   Android → 56dp  (Material Design bottom navigation spec)
//   Web    → 84px  (fixed web tab bar height in tabs/_layout.tsx)
const TAB_BAR_HEIGHT: number = Platform.select({
  ios: 49,
  android: 56,
  web: 84,
  default: 49,
})!;

// ── Why 28, not 8 ────────────────────────────────────────────────────────────
// The Channels tab has a "pill" icon (height 56, marginTop -20) that protrudes
// 20pt ABOVE the tab bar's top edge.  On Android, that pill has elevation: 10
// when focused, which is HIGHER than the mini player's elevation: 8.  A gap
// smaller than 20pt means the focused pill overlaps the mini player's bottom
// edge AND renders on top of it (higher elevation wins).
// 28pt = 20pt pill clearance + 8pt breathing room above the pill tip.
const MINI_PLAYER_GAP = 28;

// Minimum horizontal padding from screen edges in any orientation.
const H_INSET = 8;

// ─── Animation constants ───────────────────────────────────────────────────────
const SLIDE_APPEAR_DURATION  = 240; // ms — slide up + fade in
const SLIDE_DISMISS_DURATION = 180; // ms — fade out + slide down

// ─── MiniPlayer ───────────────────────────────────────────────────────────────
export function MiniPlayer() {
  const c            = useColors();
  const colorScheme  = useColorScheme();
  const isDark       = colorScheme === "dark";
  const insets       = useSafeAreaInsets();

  // Subscribes to dimension / orientation changes so all position values are
  // recalculated on every rotation, fold, or multi-window resize event.
  const { height: screenHeight } = useWindowDimensions();

  const {
    currentSermon,
    isPlaying,
    isLive,
    isBroadcastMode,
    isRadioMode,
    togglePlay,
    playNext,
  } = usePlayer();
  const { currentTime, duration } = usePlayerProgress();

  // V2 broadcast snapshot — current program title + thumbnail.
  const apiBase = getApiBase() ?? "";
  const { snapshot: v2Snapshot } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });
  const v2Current      = v2Snapshot.lastServerSnapshot?.current;
  const broadcastTitle = isBroadcastMode ? (v2Current?.title ?? null) : null;
  const broadcastThumb = isBroadcastMode ? (v2Current?.thumbnailUrl ?? null) : null;

  // ── Visibility + mount state ──────────────────────────────────────────────
  // `shouldRender` stays true during the dismiss animation so the fade-out
  // completes before we actually unmount the view.
  const isVisible    = !!(currentSermon || isLive || isBroadcastMode);
  const [shouldRender, setShouldRender] = useState(isVisible);

  // ── Animated value: 0 = hidden, 1 = fully visible ────────────────────────
  const animProgress = useRef(new Animated.Value(isVisible ? 1 : 0)).current;

  useEffect(() => {
    if (isVisible) {
      // Mount first, then animate in.
      setShouldRender(true);
      animProgress.stopAnimation();
      Animated.timing(animProgress, {
        toValue: 1,
        duration: SLIDE_APPEAR_DURATION,
        useNativeDriver: true,
      }).start();
    } else {
      // Animate out, then unmount.
      animProgress.stopAnimation();
      Animated.timing(animProgress, {
        toValue: 0,
        duration: SLIDE_DISMISS_DURATION,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setShouldRender(false);
      });
    }
  }, [isVisible, animProgress]);

  // ── Keyboard avoidance (iOS only) ─────────────────────────────────────────
  // On iOS the keyboard overlays content without pushing the layout up.
  // Lifting the mini player above the keyboard keeps it fully visible.
  // Android: softwareKeyboardLayoutMode is "unspecified" (adjustUnspecified)
  // so react-native-keyboard-controller's WindowInsetsAnimation callbacks
  // manage insets — the layout engine does not need to resize the window.
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardWillShow", (e) => {
      setKeyboardOffset(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardOffset(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // ── Foreground recovery (orientation + foldable + lock-screen) ───────────
  // Forces a fresh re-render each time the app returns to the foreground so
  // all derived position values are recalculated from current state.  We do
  // NOT use a `key` prop for this — a key change unmounts the view (visible
  // flicker).  A state update alone re-renders and passes fresh props to the
  // native layout engine, which is sufficient.
  const appStateRef  = useRef<AppStateStatus>(AppState.currentState);
  const [, setRecoveryTick] = useState(0);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && next === "active") {
        setRecoveryTick((t) => t + 1);
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  // ── Self-healing bounds validation ────────────────────────────────────────
  // Detects off-screen rendering (can happen on foldable devices when the
  // screen surface changes mid-session) and applies a corrective offset.
  const [forcedOffset, setForcedOffset] = useState(0);
  const selfHealRef  = useRef(false);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      // y = distance from parent top to this view's top (negative if off-screen above).
      // If the top edge is above the screen, or the bottom edge is below it,
      // apply a corrective upward shift.
      const topEdge    = y;
      const bottomEdge = y + height;
      if (topEdge < 0 && !selfHealRef.current) {
        selfHealRef.current = true;
        setForcedOffset(Math.abs(topEdge) + 8);
      } else if (bottomEdge > screenHeight && !selfHealRef.current) {
        selfHealRef.current = true;
        setForcedOffset(bottomEdge - screenHeight + 8);
      } else if (topEdge >= 0 && bottomEdge <= screenHeight && selfHealRef.current) {
        selfHealRef.current = false;
        setForcedOffset(0);
      }
    },
    [screenHeight],
  );

  // ── Guard against rapid double-taps ───────────────────────────────────────
  const navigatingRef      = useRef(false);
  const navigatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Early exit ─────────────────────────────────────────────────────────────
  if (!shouldRender) return null;

  // ── Derived display values ─────────────────────────────────────────────────
  const title = isLive
    ? "Live"
    : isBroadcastMode
      ? (broadcastTitle ?? "Live")
      : (currentSermon?.title ?? "");

  const subtitle = isLive
    ? "Watch Now"
    : isBroadcastMode
      ? "ON AIR · Live Broadcast"
      : isRadioMode
        ? "Radio Mode"
        : (currentSermon?.preacher ?? "");

  const thumbUri    = broadcastThumb ?? currentSermon?.thumbnailUrl ?? null;
  const progress    = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const showProgress = !isLive && !isBroadcastMode && duration > 0;

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleToggle = () => {
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    togglePlay();
  };

  const handleNext = () => {
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playNext();
  };

  // Clear navigation debounce timer on unmount to prevent a stale ref write
  // after the component is gone (benign in practice, but clean and avoids
  // any ref-leak warnings from React's strict-mode double-invoke).
  useEffect(() => () => {
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
  }, []);

  const handlePress = () => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    navigatingTimerRef.current = setTimeout(() => {
      navigatingRef.current = false;
      navigatingTimerRef.current = null;
    }, 600);

    if (isLive) {
      navigateToPlayer({ live: "true", title: "Live Broadcast", preacher: "JCTM" });
    } else if (isBroadcastMode) {
      navigateToPlayer({ broadcastMode: "true" });
    } else if (currentSermon) {
      navigateToSermon(currentSermon);
    }
  };

  // ── Position calculation ───────────────────────────────────────────────────
  //
  // bottom = (tab bar content height)
  //        + (gap to clear the Channels pill that protrudes above tab bar)
  //        + (system navigation bar / home indicator inset)
  //        + (keyboard height, iOS only)
  //        + (self-healing correction if detected off-screen)
  //
  // On web there is no system inset and no pill protrusion.
  const bottomOffset: number =
    Platform.OS === "web"
      ? TAB_BAR_HEIGHT
      : TAB_BAR_HEIGHT + MINI_PLAYER_GAP + insets.bottom + keyboardOffset + forcedOffset;

  // Horizontal insets: respect safe-area curves (landscape notch / punch-hole).
  const leftInset  = Math.max(H_INSET, insets.left  + H_INSET);
  const rightInset = Math.max(H_INSET, insets.right + H_INSET);

  // ── Animation styles ───────────────────────────────────────────────────────
  // Slide up 12pt while fading in; slide down 12pt while fading out.
  const animatedStyle = {
    opacity: animProgress,
    transform: [
      {
        translateY: animProgress.interpolate({
          inputRange:  [0, 1],
          outputRange: [12, 0],
        }),
      },
    ],
  };

  // ── Inner content (platform-independent) ──────────────────────────────────
  const content = (
    <>
      {showProgress && (
        <View style={[styles.progressTrack, { backgroundColor: c.border }]}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: c.primary,
                width: `${Math.round(progress * 100)}%` as `${number}%`,
              },
            ]}
          />
        </View>
      )}
      <Pressable
        onPress={handlePress}
        style={({ pressed }) => [styles.inner, { opacity: pressed ? 0.85 : 1 }]}
        android_ripple={{ color: "rgba(0,0,0,0.06)", borderless: false }}
        accessibilityRole="button"
        accessibilityLabel={`Now playing: ${title}${subtitle ? ` — ${subtitle}` : ""}. Tap to open player.`}
      >
        {/* ── Artwork ─────────────────────────────────────────────────── */}
        <View style={styles.info}>
          {thumbUri ? (
            <View style={styles.artworkWrap}>
              <Image
                source={{ uri: thumbUri }}
                placeholder={PLACEHOLDER}
                style={styles.artwork}
                contentFit="cover"
                transition={200}
              />
              {(isLive || isBroadcastMode) && (
                <View
                  style={styles.artworkLiveDot}
                  accessibilityLabel="Live"
                  accessibilityRole="image"
                />
              )}
            </View>
          ) : (
            <View style={[styles.artworkFallback, { backgroundColor: c.muted }]}>
              {isLive || isBroadcastMode || isRadioMode ? (
                <Feather name="radio" size={16} color={c.primary} />
              ) : (
                <Feather name="play" size={16} color={c.mutedForeground} />
              )}
            </View>
          )}

          {!thumbUri && (isLive || isBroadcastMode) && <LiveBadge size="small" />}
          {!thumbUri && isRadioMode && !isLive && !isBroadcastMode && (
            <View style={[styles.radioBadge, { backgroundColor: c.primary }]}>
              <Feather name="radio" size={10} color="#FFF" />
            </View>
          )}

          {/* ── Text ──────────────────────────────────────────────────── */}
          <View style={styles.textContainer}>
            <Text
              style={[styles.title, { color: c.foreground }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {title}
            </Text>
            <Text
              style={[styles.subtitle, { color: c.mutedForeground }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {subtitle}
            </Text>
          </View>
        </View>

        {/* ── Controls ────────────────────────────────────────────────── */}
        <View style={styles.controls}>
          <Pressable
            onPress={handleToggle}
            hitSlop={8}
            style={styles.controlBtn}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? "Pause" : "Play"}
          >
            <Feather
              name={isPlaying ? "pause" : "play"}
              size={22}
              color={c.foreground}
            />
          </Pressable>
          {!isLive && !isBroadcastMode && (
            <Pressable
              onPress={handleNext}
              hitSlop={8}
              style={styles.controlBtn}
              accessibilityRole="button"
              accessibilityLabel="Skip to next"
            >
              <Feather name="skip-forward" size={20} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>
      </Pressable>
    </>
  );

  // ── Android rendering ──────────────────────────────────────────────────────
  //
  // Requires a TWO-LAYER approach for correct shadow + content clipping:
  //
  //  OUTER (Animated.View)
  //    • carries `elevation` and `borderRadius` WITHOUT `overflow:"hidden"`
  //    • `overflow:"hidden"` on the same view as `elevation` clips the
  //      Material shadow on Android < 14
  //    • `pointerEvents="box-none"` lets touches in the transparent shadow
  //      region pass through to the views beneath
  //
  //  INNER (View)
  //    • carries `overflow:"hidden"` + `borderRadius` to clip the ripple,
  //      progress bar, and artwork to the rounded shape
  //    • does NOT carry elevation (avoids double-shadow artefact)
  //
  // elevation: 12  — must beat the focused Channels pill (elevation: 10)
  // so the mini player is ALWAYS drawn above it when the two overlap during
  // the transition from gap=8 to gap=28.  With gap=28 they no longer overlap,
  // but the higher elevation is kept as a belt-and-suspenders guard.
  if (Platform.OS === "android") {
    return (
      <Animated.View
        onLayout={handleLayout}
        style={[
          styles.androidOuter,
          animatedStyle,
          {
            bottom: bottomOffset,
            left: leftInset,
            right: rightInset,
            elevation: 12,
            zIndex: 1000,
            backgroundColor: c.surfaceGlass,
            borderColor: c.border,
          },
        ]}
        // box-none: passes touches through the shadow halo (outside the pill
        // itself) to the tab bar and screen content beneath.
        pointerEvents="box-none"
        accessibilityLabel="Mini player"
        importantForAccessibility="yes"
      >
        <View
          style={[styles.androidInner, { backgroundColor: c.surfaceGlass }]}
        >
          {content}
        </View>
      </Animated.View>
    );
  }

  // ── iOS rendering ─────────────────────────────────────────────────────────
  //
  // The Animated.View is the positioning + animation shell.
  // BlurView with absoluteFill renders the frosted-glass background behind
  // the content.  overflow:"hidden" + borderRadius on the Animated.View
  // clips both the blur and the content to the rounded shape.
  //
  // We do NOT put BlurView as the root because Animated cannot drive
  // transitions on a non-Animated component directly.
  if (Platform.OS === "ios") {
    return (
      <Animated.View
        onLayout={handleLayout}
        style={[
          styles.iosOuter,
          animatedStyle,
          {
            bottom: bottomOffset,
            left: leftInset,
            right: rightInset,
            borderColor: c.border,
          },
        ]}
        accessibilityLabel="Mini player"
      >
        {/* Frosted-glass layer — sits behind the content */}
        <BlurView
          intensity={80}
          tint={isDark ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
        />
        {content}
      </Animated.View>
    );
  }

  // ── Web / fallback rendering ───────────────────────────────────────────────
  return (
    <Animated.View
      onLayout={handleLayout}
      style={[
        styles.webOuter,
        animatedStyle,
        {
          backgroundColor: c.surfaceGlass,
          borderColor: c.border,
          bottom: bottomOffset,
          left: leftInset,
          right: rightInset,
        },
      ]}
    >
      {content}
    </Animated.View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const BORDER_RADIUS = 16;

const styles = StyleSheet.create({
  // ── Android two-layer containers ──────────────────────────────────────────
  androidOuter: {
    position: "absolute",
    borderRadius: BORDER_RADIUS,
    borderWidth: 1,
    // NO overflow:"hidden" — would clip the Material elevation shadow.
  },
  androidInner: {
    borderRadius: BORDER_RADIUS - 1, // 1dp less prevents hairline gap at the corner
    overflow: "hidden",
  },

  // ── iOS container (Animated.View shell for BlurView) ──────────────────────
  iosOuter: {
    position: "absolute",
    borderRadius: BORDER_RADIUS,
    borderWidth: 1,
    overflow: "hidden",   // clips BlurView + content to the rounded rect
    zIndex: 999,
  },

  // ── Web / fallback container ───────────────────────────────────────────────
  webOuter: {
    position: "absolute",
    borderRadius: BORDER_RADIUS,
    borderWidth: 1,
    overflow: "hidden",
    zIndex: 999,
  },

  // ── Progress bar ──────────────────────────────────────────────────────────
  progressTrack: {
    height: 2,
    width: "100%",
  },
  progressFill: {
    height: 2,
    borderRadius: 1,
  },

  // ── Row layout ────────────────────────────────────────────────────────────
  inner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  info: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  },

  // ── Artwork ───────────────────────────────────────────────────────────────
  artworkWrap: {
    position: "relative",
    flexShrink: 0,
  },
  artwork: {
    width: 42,
    height: 42,
    borderRadius: 8,
  },
  artworkLiveDot: {
    position: "absolute",
    bottom: 3,
    right: 3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ef4444",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  artworkFallback: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  radioBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  // ── Text ──────────────────────────────────────────────────────────────────
  textContainer: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },

  // ── Controls ──────────────────────────────────────────────────────────────
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  // 44×44pt meets iOS HIG + Android Material minimum touch-target specs.
  // hitSlop={8} extends the effective tap area to ~60×60pt.
  controlBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
