import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  type AppStateStatus,
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

// ─── Layout constants ─────────────────────────────────────────────────────────
// React Navigation BottomTabBar height defaults:
//   iOS   → 49pt  (Apple HIG compact bottom bar)
//   Android → 56dp (Material Design bottom navigation spec)
//   Web   → 84px  (this codebase's fixed web tab bar, see tabs/_layout.tsx)
//
// Using the WRONG value here is the primary Android clipping root cause:
// 49 < 56 means the mini player overlaps the physical tab bar by 7dp on every
// Android device, causing the bottom of the player to be hidden behind it.
const TAB_BAR_HEIGHT: number = Platform.select({ ios: 49, android: 56, web: 84, default: 49 })!;

// Gap between the top of the tab bar and the bottom edge of the mini player.
// Large enough to clear the elevated Channels "pill" button (marginTop: -20
// in _layout.tsx means it protrudes 20pt above the tab bar top).
const MINI_PLAYER_GAP = 8;

// Minimum horizontal inset from screen edges.
// Applied on both portrait and landscape to keep content in the safe zone.
const H_INSET = 8;

// ─── MiniPlayer ───────────────────────────────────────────────────────────────

export function MiniPlayer() {
  const c = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const insets = useSafeAreaInsets();

  // Subscribes to dimension/orientation changes — ensures bottomOffset and
  // horizontal insets are recalculated on every rotation or fold event.
  // The return value is intentionally unused; the subscription is the goal.
  useWindowDimensions();

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

  // V2 broadcast snapshot — resolves the current program title and thumbnail.
  const apiBase = getApiBase() ?? "";
  const { snapshot: v2Snapshot } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });
  const v2Current = v2Snapshot.lastServerSnapshot?.current;
  const broadcastTitle = isBroadcastMode ? (v2Current?.title ?? null) : null;
  const broadcastThumb = isBroadcastMode ? (v2Current?.thumbnailUrl ?? null) : null;

  // ── Automatic recovery after system events ────────────────────────────────
  // Android layout can freeze after screen-lock, multitask switches, or
  // foldable device fold/unfold. We force a re-render each time the app
  // returns to the foreground so all position values are recalculated fresh.
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const [recoveryTick, setRecoveryTick] = useState(0);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (
        appStateRef.current.match(/inactive|background/) &&
        next === "active"
      ) {
        setRecoveryTick((t) => t + 1);
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  // Guard against rapid double-taps pushing duplicate /player entries.
  const navigatingRef = useRef(false);

  if (!currentSermon && !isLive && !isBroadcastMode) return null;

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

  const thumbUri = broadcastThumb ?? currentSermon?.thumbnailUrl ?? null;

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const showProgress = !isLive && !isBroadcastMode && duration > 0;

  const handleToggle = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    togglePlay();
  };

  const handleNext = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playNext();
  };

  const handlePress = () => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    setTimeout(() => { navigatingRef.current = false; }, 600);

    if (isLive) {
      navigateToPlayer({ live: "true", title: "Live Broadcast", preacher: "JCTM" });
    } else if (isBroadcastMode) {
      navigateToPlayer({ broadcastMode: "true" });
    } else if (currentSermon) {
      navigateToSermon(currentSermon);
    }
  };

  // ── Position calculation ───────────────────────────────────────────────────
  // Bottom offset: place the mini player just above the tab bar, respecting
  // the bottom safe-area inset (gesture bar / home indicator / nav buttons).
  //
  // On Android the safe-area inset already accounts for the system navigation
  // bar (whether 3-button or gesture). On iOS it accounts for the home
  // indicator. On web there are no insets — the fixed offset covers the bar.
  const bottomOffset: number =
    Platform.OS === "web"
      ? TAB_BAR_HEIGHT
      : TAB_BAR_HEIGHT + MINI_PLAYER_GAP + insets.bottom;

  // Horizontal position — respect left/right safe-area insets (landscape on
  // devices with curved edges or punch-hole cameras) while keeping the player
  // visible on all screen widths.
  const leftInset = Math.max(H_INSET, insets.left + H_INSET);
  const rightInset = Math.max(H_INSET, insets.right + H_INSET);

  // ── Rendered content (platform-independent) ───────────────────────────────
  const content = (
    <View key={`mp-${recoveryTick}`}>
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
      >
        {/* ── Info ──────────────────────────────────────────────────────── */}
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
                <View style={styles.artworkLiveDot} />
              )}
            </View>
          ) : (
            <View style={[styles.artworkFallback, { backgroundColor: c.muted }]}>
              {isLive || isBroadcastMode ? (
                <Feather name="radio" size={16} color={c.primary} />
              ) : isRadioMode ? (
                <Feather name="radio" size={16} color={c.primary} />
              ) : (
                <Feather name="play" size={16} color={c.mutedForeground} />
              )}
            </View>
          )}

          {!thumbUri && (isLive || isBroadcastMode) && (
            <LiveBadge size="small" />
          )}
          {!thumbUri && isRadioMode && !isLive && !isBroadcastMode && (
            <View style={[styles.radioBadge, { backgroundColor: c.primary }]}>
              <Feather name="radio" size={10} color="#FFF" />
            </View>
          )}

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

        {/* ── Controls ──────────────────────────────────────────────────── */}
        <View style={styles.controls}>
          <Pressable
            onPress={handleToggle}
            hitSlop={8}
            style={styles.controlBtn}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? "Pause" : "Play"}
          >
            <Feather name={isPlaying ? "pause" : "play"} size={22} color={c.foreground} />
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
    </View>
  );

  // ── Android rendering ──────────────────────────────────────────────────────
  // Android requires a TWO-LAYER approach for correct rendering:
  //
  // OUTER layer  → carries `elevation` (shadow + stacking order) and
  //                `borderRadius` WITHOUT `overflow: "hidden"`.
  //                `overflow: "hidden"` on the same view as `elevation`
  //                clips the Material shadow in all Android versions < 14.
  //
  // INNER layer  → carries `overflow: "hidden"` + `borderRadius` to clip
  //                child content (progress bar, ripple, artwork) to the
  //                rounded shape without touching the shadow.
  //
  // zIndex is also needed for the React Native view tree on Android when
  // multiple absolute-positioned siblings exist (e.g. the tab bar overlay).
  if (Platform.OS === "android") {
    return (
      <View
        style={[
          styles.androidOuter,
          {
            bottom: bottomOffset,
            left: leftInset,
            right: rightInset,
            // Elevation controls shadow depth AND draw order on Android.
            // 8dp puts it above the tab bar (elevation 4) and any screen
            // overlays, but below modals (elevation 24+).
            elevation: 8,
            zIndex: 999,
            backgroundColor: c.surfaceGlass,
            borderColor: c.border,
          },
        ]}
      >
        <View
          style={[
            styles.androidInner,
            { backgroundColor: c.surfaceGlass },
          ]}
        >
          {content}
        </View>
      </View>
    );
  }

  // ── iOS rendering (BlurView) ───────────────────────────────────────────────
  if (Platform.OS === "ios") {
    return (
      <BlurView
        intensity={80}
        tint={isDark ? "dark" : "light"}
        style={[
          styles.container,
          {
            borderColor: c.border,
            bottom: bottomOffset,
            left: leftInset,
            right: rightInset,
          },
        ]}
      >
        {content}
      </BlurView>
    );
  }

  // ── Web / fallback rendering ───────────────────────────────────────────────
  return (
    <View
      style={[
        styles.container,
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
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Base container (iOS + web) ─────────────────────────────────────────────
  container: {
    position: "absolute",
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    // Ensure it renders above the tab bar in the React tree (iOS uses
    // painter's algorithm; Android uses elevation instead).
    zIndex: 999,
  },

  // ── Android two-layer containers ──────────────────────────────────────────
  // Outer: provides elevation/shadow — must NOT have overflow:hidden.
  androidOuter: {
    position: "absolute",
    borderRadius: 16,
    borderWidth: 1,
    // No overflow:hidden here — it would clip the Material drop-shadow.
  },
  // Inner: clips content to the rounded shape without touching the shadow.
  androidInner: {
    borderRadius: 15,           // 1px less than outer to avoid hair-line gap
    overflow: "hidden",
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
  info: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },

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

  // ── Playback controls ─────────────────────────────────────────────────────
  controls: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  // 44×44pt meets both iOS HIG and Android Material minimum touch targets.
  // hitSlop={8} extends the effective tap area to ~60×60pt for small fingers.
  controlBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
