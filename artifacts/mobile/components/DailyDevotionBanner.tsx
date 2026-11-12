/**
 * DailyDevotionBanner — home-screen entry point to the JCTM daily devotion.
 *
 * Consumes useDailyDevotion() (owned by the main agent / service layer, which
 * restricts URLs to the official website). This component never invents
 * devotion metadata: when no devotion is available it shows only a link to the
 * official devotion page.
 */
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useDailyDevotion } from "@/hooks/useDailyDevotion";
import { OFFICIAL_DEVOTION_URL, MIN_TOUCH } from "@/constants/design";
import { PressableScale } from "@/components/PressableScale";
import { formatDevotionDate } from "@/services/dailyDevotionCore";

type OpenState = "idle" | "opening" | "failed";

export function DailyDevotionBanner() {
  const c = useColors();
  const { devotion, loading, refreshing, stale, error, refresh } = useDailyDevotion();
  const [openState, setOpenState] = useState<OpenState>("idle");
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  const targetUrl = devotion?.url || OFFICIAL_DEVOTION_URL;

  const openDevotion = useCallback(async (url: string) => {
    setOpenState("opening");
    try {
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        toolbarColor: c.primary,
        controlsColor: c.primary,
      });
      setOpenState("idle");
    } catch {
      setOpenState("failed");
    }
  }, [c.primary]);

  const openInSystemBrowser = useCallback(async () => {
    try {
      await Linking.openURL(targetUrl);
      setOpenState("idle");
    } catch {
      setOpenState("failed");
    }
  }, [targetUrl]);

  const dateLabel = formatDevotionDate(devotion?.publishedAt ?? null);
  const showImage = !!devotion?.imageUrl && devotion.imageUrl !== failedImageUrl;

  return (
    <View
      style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
      testID="daily-devotion-banner"
    >
      <View style={[styles.goldRule, { backgroundColor: c.gold }]} />
      <View style={styles.headerRow}>
        <View style={[styles.eyebrowPill, { backgroundColor: c.goldSoft }]}>
          <Feather name="book-open" size={12} color={c.gold} />
          <Text style={[styles.eyebrow, { color: c.gold }]} accessibilityRole="header">
            Daily Devotion
          </Text>
        </View>
        {(stale || refreshing) && devotion ? (
          <Pressable
            onPress={refresh}
            disabled={refreshing}
            hitSlop={10}
            testID="daily-devotion-refresh"
            accessibilityRole="button"
            accessibilityLabel={refreshing ? "Refreshing devotion" : "Saved devotion shown. Refresh"}
            style={styles.staleChip}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={c.mutedForeground} />
            ) : (
              <Feather name="refresh-cw" size={11} color={c.mutedForeground} />
            )}
            <Text style={[styles.staleText, { color: c.mutedForeground }]}>
              {refreshing ? "Updating" : "Saved copy"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {loading && !devotion ? (
        <View style={styles.body} accessibilityLabel="Loading today's devotion">
          <View style={[styles.skelLine, { width: "78%", backgroundColor: c.muted }]} />
          <View style={[styles.skelLine, { width: "92%", height: 12, backgroundColor: c.muted }]} />
          <View style={[styles.skelLine, { width: "64%", height: 12, backgroundColor: c.muted }]} />
        </View>
      ) : devotion ? (
        <View style={styles.contentRow}>
          {showImage ? (
            <Image
              source={{ uri: devotion.imageUrl as string }}
              style={styles.image}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={180}
              onError={() => setFailedImageUrl(devotion.imageUrl)}
              accessible={false}
            />
          ) : null}
          <View style={styles.body}>
            {dateLabel ? (
              <Text style={[styles.date, { color: c.mutedForeground }]}>{dateLabel}</Text>
            ) : null}
            <Text style={[styles.title, { color: c.foreground }]} numberOfLines={3}>
              {devotion.title}
            </Text>
            {!!devotion.excerpt && (
              <Text style={[styles.excerpt, { color: c.mutedForeground }]} numberOfLines={4}>
                {devotion.excerpt}
              </Text>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={[styles.title, { color: c.foreground }]}>
            Today's devotion is on the JCTM website
          </Text>
          <Text style={[styles.excerpt, { color: c.mutedForeground }]}>
            {error
              ? "We couldn't load the latest devotion here. You can still read it on the official site."
              : "Open the official devotion page to read today's word."}
          </Text>
          {error ? (
            <Pressable
              onPress={refresh}
              hitSlop={10}
              testID="daily-devotion-retry"
              accessibilityRole="button"
              accessibilityLabel="Try loading the devotion again"
              style={styles.inlineLink}
            >
              <Feather name="rotate-ccw" size={13} color={c.primary} />
              <Text style={[styles.inlineLinkText, { color: c.primary }]}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      <PressableScale
        onPress={() => openDevotion(targetUrl)}
        disabled={openState === "opening"}
        testID="daily-devotion-read"
        accessibilityRole="link"
        accessibilityLabel="Read Full Devotion"
        accessibilityHint="Opens the devotion on the official JCTM website"
        style={[styles.cta, { backgroundColor: c.primary }]}
      >
        <Text style={[styles.ctaText, { color: c.primaryForeground }]}>Read Full Devotion</Text>
        {openState === "opening" ? (
          <ActivityIndicator size="small" color={c.primaryForeground} />
        ) : (
          <Feather name="arrow-up-right" size={16} color={c.primaryForeground} />
        )}
      </PressableScale>

      {openState === "failed" ? (
        <View
          style={[styles.failBox, { backgroundColor: c.dangerSurface }]}
          accessibilityLiveRegion="polite"
        >
          <Text style={[styles.failText, { color: c.dangerForeground }]}>
            The devotion page didn't open.
          </Text>
          <View style={styles.failActions}>
            <Pressable
              onPress={() => openDevotion(targetUrl)}
              hitSlop={8}
              testID="daily-devotion-open-retry"
              accessibilityRole="button"
              style={styles.failBtn}
            >
              <Text style={[styles.failBtnText, { color: c.dangerForeground }]}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={openInSystemBrowser}
              hitSlop={8}
              testID="daily-devotion-open-browser"
              accessibilityRole="button"
              accessibilityLabel="Open in your browser"
              style={styles.failBtn}
            >
              <Text style={[styles.failBtnText, { color: c.dangerForeground }]}>Open in browser</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}


const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    paddingTop: 18,
    gap: 14,
    overflow: "hidden",
  },
  goldRule: { position: "absolute", top: 0, left: 0, right: 0, height: 3 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  eyebrowPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  eyebrow: { fontFamily: "Inter_700Bold", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase" },
  staleChip: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 28 },
  staleText: { fontFamily: "Inter_500Medium", fontSize: 11 },
  contentRow: { flexDirection: "row", gap: 14, flexWrap: "wrap" },
  image: { width: 96, height: 96, borderRadius: 12 },
  body: { flex: 1, minWidth: 180, gap: 6 },
  date: { fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16 },
  title: { fontFamily: "Inter_700Bold", fontSize: 18, lineHeight: 24, letterSpacing: -0.2 },
  excerpt: { fontFamily: "Inter_400Regular", fontSize: 14, lineHeight: 21 },
  skelLine: { height: 18, borderRadius: 6 },
  inlineLink: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: 36 },
  inlineLinkText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  cta: {
    minHeight: MIN_TOUCH,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  ctaText: { fontFamily: "Inter_700Bold", fontSize: 15, letterSpacing: 0.1, textAlign: "center", flexShrink: 1 },
  failBox: { borderRadius: 12, padding: 12, gap: 8 },
  failText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  failActions: { flexDirection: "row", gap: 16, flexWrap: "wrap" },
  failBtn: { minHeight: 36, justifyContent: "center" },
  failBtnText: { fontFamily: "Inter_700Bold", fontSize: 13, textDecorationLine: "underline" },
});
