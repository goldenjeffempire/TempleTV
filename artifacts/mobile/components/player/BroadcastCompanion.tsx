import React, { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import type { V2Item } from "@workspace/player-core";
import type { useColors } from "@/hooks/useColors";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

/**
 * Live countdown showing how many minutes remain in the current broadcast
 * program. Updates every 10 s to keep re-renders minimal.
 */
export function BroadcastTimeRemaining({
  endsAtMs,
  textColor,
}: {
  endsAtMs: number;
  textColor: string;
}) {
  const [secsLeft, setSecsLeft] = useState(() =>
    Math.max(0, Math.floor((endsAtMs - Date.now()) / 1000)),
  );
  useEffect(() => {
    const tick = () =>
      setSecsLeft(Math.max(0, Math.floor((endsAtMs - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, [endsAtMs]);
  if (secsLeft <= 0) return null;
  const mins = Math.floor(secsLeft / 60);
  const label =
    mins >= 60
      ? `${Math.floor(mins / 60)}h ${mins % 60}m remaining`
      : mins > 0
      ? `${mins}m remaining`
      : "Ending soon";
  return (
    <Text style={[styles.timeRemaining, { color: textColor }]}>{label}</Text>
  );
}

/**
 * Compact "Up Next" strip showing the next item queued in the V2 broadcast
 * engine so viewers know what's coming after the current program.
 */
export function BroadcastUpNextStrip({
  item,
  colors,
}: {
  item: V2Item;
  colors: ReturnType<typeof useColors>;
}) {
  const startTime = new Date(item.startsAtMs);
  const timeLabel = startTime.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <View
      style={[
        styles.upNextContainer,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.upNextLabel, { color: colors.mutedForeground }]}>
        UP NEXT
      </Text>
      <View style={styles.upNextRow}>
        {item.thumbnailUrl ? (
          <Image
            source={{ uri: item.thumbnailUrl }}
            style={styles.upNextThumb}
            resizeMode="cover"
          />
        ) : (
          <Image
            source={PLACEHOLDER}
            style={styles.upNextThumb}
            resizeMode="cover"
          />
        )}
        <View style={styles.upNextInfo}>
          <Text
            style={[styles.upNextTitle, { color: colors.foreground }]}
            numberOfLines={2}
          >
            {item.title}
          </Text>
          <Text style={[styles.upNextTime, { color: colors.mutedForeground }]}>
            {timeLabel}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  timeRemaining: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginTop: 2,
  },
  upNextContainer: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    gap: 6,
    marginTop: 4,
  },
  upNextLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.8,
  },
  upNextRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  upNextThumb: {
    width: 56,
    height: 32,
    borderRadius: 4,
    flexShrink: 0,
  },
  upNextInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  upNextTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 18,
  },
  upNextTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
});
