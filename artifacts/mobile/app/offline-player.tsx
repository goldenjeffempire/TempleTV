import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { LocalVideoPlayer } from "@/components/LocalVideoPlayer";
import { useColors } from "@/hooks/useColors";
import { usePlayer } from "@/context/PlayerContext";
import { downloadManager, type DownloadItem } from "@/services/downloadManager";
import { useDownloadContext } from "@/context/DownloadContext";
import * as audioController from "@/services/audioController";

/** Deliberately no broadcast session, viewer lease, auth request or API hook. */
export default function OfflinePlayerScreen() {
  const { id, positionSecs } = useLocalSearchParams<{ id?: string; positionSecs?: string }>();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { stopPlayback } = usePlayer();
  const { downloads } = useDownloadContext();
  const [item, setItem] = useState<DownloadItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(AppState.currentState === "active");
  const position = useRef(0);
  const lastSave = useRef(0);
  const saved = downloads.find(d => d.videoId === id);

  useEffect(() => {
    stopPlayback();
    audioController.requestRadioStop();
    const sub = AppState.addEventListener("change", state => {
      setActive(state === "active");
      if (id) downloadManager.savePosition(id, position.current);
    });
    return () => {
      sub.remove();
      if (id) downloadManager.savePosition(id, position.current);
    };
  }, [id, stopPlayback]);

  useEffect(() => {
    let mounted = true;
    setItem(null); setError(null);
    downloadManager.validateForPlayback(id ?? "").then(recording => {
      if (!mounted) return;
      const requested = Number(positionSecs);
      position.current = positionSecs && Number.isFinite(requested) && requested >= 0
        ? requested : recording.positionSecs ?? 0;
      setItem(recording);
    }).catch(e => { if (mounted) setError(e instanceof Error ? e.message : "Offline recording could not be opened"); });
    return () => { mounted = false; };
  }, [id, positionSecs]);

  useEffect(() => {
    if (item && (!saved || saved.status !== "completed")) {
      setItem(null); setError("This offline copy was removed or its access ended.");
    }
  }, [saved?.status, !!saved, item]);

  useEffect(() => {
    if (!item?.expiresAt) return;
    const timer = setTimeout(() => {
      setItem(null); setError("Offline access needs renewal. Connect and open Offline Broadcasts.");
    }, Math.max(0, Date.parse(item.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [item?.expiresAt]);

  const onProgress = useCallback((seconds: number) => {
    position.current = seconds;
    if (id && Date.now() - lastSave.current >= 5000) {
      lastSave.current = Date.now(); downloadManager.savePosition(id, seconds);
    }
  }, [id]);
  return <View style={[styles.page, { backgroundColor: c.background, paddingBottom: insets.bottom }]}>
    <AppHeader title="Offline recording" onBack={() => router.canGoBack() ? router.back() : router.replace("/downloads")} />
    <View style={styles.body}>
      <Text style={[styles.badge, { color: c.primary }]}>SAVED RECORDING · NOT LIVE</Text>
      {error ? <View accessibilityRole="alert" style={styles.message}>
        <Text style={{ color: c.foreground }}>{error}</Text>
        <Pressable onPress={() => router.replace("/downloads")} accessibilityRole="button">
          <Text style={[styles.link, { color: c.primary }]}>Open Offline Broadcasts</Text>
        </Pressable>
      </View> : item ? <>
        {active && <LocalVideoPlayer
          videoUrl={item.localPath!}
          thumbnailUrl={item.localThumbnail ?? undefined}
          title={item.videoTitle}
          startPositionMs={position.current * 1000}
          offlinePlayback
          onProgress={onProgress}
          onEnd={() => { position.current = 0; downloadManager.savePosition(item.videoId, 0); }}
          onError={() => { setItem(null); setError("This recording could not be decoded. Re-download it while online."); }}
        />}
        <Text style={[styles.title, { color: c.foreground }]}>{item.videoTitle}</Text>
        <Text style={{ color: c.mutedForeground }}>{item.preacher} · {item.duration}</Text>
        <Text style={[styles.note, { color: c.mutedForeground }]}>Plays from this device. Reconnecting will not switch you back to live playback.</Text>
      </> : <View style={styles.message}>
        <ActivityIndicator color={c.primary} />
        <Text style={{ color: c.foreground }}>Checking saved recording…</Text>
      </View>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 }, body: { padding: 16, gap: 16 },
  badge: { fontSize: 12, fontWeight: "700" }, title: { fontSize: 21, fontWeight: "700" },
  note: { fontSize: 13, lineHeight: 20 }, message: { paddingVertical: 40, gap: 20 },
  link: { paddingVertical: 12, fontWeight: "600" },
});
