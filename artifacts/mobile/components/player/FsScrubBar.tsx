import React, { useRef, useState } from "react";
import { PanResponder, StyleSheet, View } from "react-native";

export function formatTime(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function FsScrubBar({
  ratio,
  onScrub,
  onScrubEnd,
}: {
  ratio: number;
  onScrub: (r: number) => void;
  onScrubEnd: (r: number) => void;
}) {
  const [barWidth, setBarWidth] = useState(0);
  const barWidthRef = useRef(0);
  const startXRef   = useRef(0);
  const lastRRef    = useRef(ratio);
  lastRRef.current  = ratio;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (evt) => {
        startXRef.current = evt.nativeEvent.locationX;
        const r = Math.max(0, Math.min(1, startXRef.current / (barWidthRef.current || 1)));
        onScrub(r);
      },
      onPanResponderMove: (_evt, gs) => {
        const x = startXRef.current + gs.dx;
        const r = Math.max(0, Math.min(1, x / (barWidthRef.current || 1)));
        onScrub(r);
      },
      onPanResponderRelease: (_evt, gs) => {
        const x = startXRef.current + gs.dx;
        const r = Math.max(0, Math.min(1, x / (barWidthRef.current || 1)));
        onScrubEnd(r);
      },
      onPanResponderTerminate: () => {
        onScrubEnd(lastRRef.current);
      },
    }),
  ).current;

  const progress = Math.max(0, Math.min(1, ratio));
  const thumbLeft = barWidth > 0 ? barWidth * progress - 7 : 0;

  return (
    <View
      style={styles.fsScrubBarWrap}
      onLayout={(e) => {
        barWidthRef.current = e.nativeEvent.layout.width;
        setBarWidth(e.nativeEvent.layout.width);
      }}
      {...pan.panHandlers}
    >
      <View style={styles.fsScrubTrack}>
        <View style={[styles.fsScrubFill, { width: `${progress * 100}%` }]} />
      </View>
      <View style={[styles.fsScrubThumb, { left: thumbLeft }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  fsScrubBarWrap: { flex: 1, height: 34, justifyContent: "center" },
  fsScrubTrack: { height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.30)", overflow: "hidden" },
  fsScrubFill: { height: 3, borderRadius: 2, backgroundColor: "#DC2626" },
  fsScrubThumb: { position: "absolute", width: 14, height: 14, borderRadius: 7, backgroundColor: "#fff", top: (34 - 14) / 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.4, shadowRadius: 3, elevation: 4 },
});
