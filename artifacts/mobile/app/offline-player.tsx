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
import { automaticBroadcast } from "@/services/automaticBroadcast";

/** Deliberately no broadcast session, viewer lease, auth request or API hook. */
export default function OfflinePlayerScreen() {
  const { id, positionSecs, broadcast } = useLocalSearchParams<{ id?: string; positionSecs?: string; broadcast?: string }>();
  const broadcastMode = broadcast === "true";
  const [selection, setSelection] = useState(id);
  const [cycle, setCycle] = useState(0);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { stopPlayback } = usePlayer();
  const { downloads } = useDownloadContext();
  const [item, setItem] = useState<DownloadItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(AppState.currentState === "active");
  const position = useRef(0);
  const lastSave = useRef(0);
  const saved = downloads.find(d => d.videoId === item?.videoId);
  const activeId = useRef<string | undefined>(undefined);
  const failedRecordings = useRef(new Set<string>());
  useEffect(() => { setSelection(id); }, [id]);

  useEffect(() => {
    stopPlayback();
    audioController.requestRadioStop();
    const sub = AppState.addEventListener("change", state => {
      setActive(state === "active");
      if (activeId.current) downloadManager.savePosition(activeId.current, position.current);
    });
    return () => {
      sub.remove();
      if (activeId.current) downloadManager.savePosition(activeId.current, position.current);
    };
  }, [stopPlayback]);

  useEffect(() => {
    let mounted = true;
    let releasePlaybackPin: (() => void) | undefined;
    setItem(null); setError(null);
    void (async () => {
      await downloadManager.init();
      if (broadcastMode) await automaticBroadcast.init();
      let selectedId = broadcastMode ?
        automaticBroadcast.choose(selection, undefined, failedRecordings.current)?.videoId : selection;
      if (!selectedId) throw new Error("No complete broadcast recordings are stored on this device yet. Preparation runs automatically on Wi-Fi while the app is open.");
      let recording: DownloadItem | undefined;
      while (selectedId && mounted) {
        releasePlaybackPin?.();
        releasePlaybackPin = downloadManager.pinForPlayback(selectedId);
        try {
          recording = await downloadManager.validateForPlayback(selectedId);
          break;
        } catch (failure) {
          if (!broadcastMode) throw failure;
          failedRecordings.current.add(selectedId);
          selectedId = automaticBroadcast.choose(undefined, selectedId, failedRecordings.current)?.videoId;
          if (!selectedId) throw new Error("Stored broadcast recordings could not be verified. Automatic repair resumes on Wi-Fi.");
        }
      }
      if (!mounted) return;
      if (!recording || !selectedId) throw new Error("No verified broadcast recording is available.");
      const requested = Number(positionSecs);
      position.current = cycle > 0 ? 0 : selectedId === id && positionSecs && Number.isFinite(requested) && requested >= 0
        ? requested : recording.positionSecs ?? 0;
      activeId.current = selectedId;
      if (broadcastMode) void automaticBroadcast.remember(selectedId).catch(() => {
        // Current playback is independent of a failed metadata/checkpoint write.
      });
      setItem(recording);
    })().catch(e => { if (mounted) setError(e instanceof Error ? e.message : "Offline recording could not be opened"); });
    return () => { mounted = false; releasePlaybackPin?.(); };
  }, [selection, id, positionSecs, broadcastMode, cycle]);

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
    if (activeId.current && Date.now() - lastSave.current >= 5000) {
      lastSave.current = Date.now(); downloadManager.savePosition(activeId.current, seconds);
    }
  }, []);
  const onEnd = useCallback(() => {
    if (!item) return;
    position.current = 0; downloadManager.savePosition(item.videoId, 0);
    if (broadcastMode) {
      const next = automaticBroadcast.choose(undefined, item.videoId, failedRecordings.current);
      if (next) { setSelection(next.videoId); setCycle(value => value + 1); }
    }
  }, [item, broadcastMode]);
  return <View style={[styles.page, { backgroundColor: c.background, paddingBottom: insets.bottom }]}>
    <AppHeader title={broadcastMode ? "Broadcast" : "Offline recording"} onBack={() => router.canGoBack() ? router.back() : router.replace(broadcastMode ? "/" : "/downloads")} />
    <View style={styles.body}>
      <Text style={[styles.badge, { color: c.primary }]}>{broadcastMode ? "OFFLINE BROADCAST · STORED ON THIS DEVICE" : "SAVED RECORDING · NOT LIVE"}</Text>
      {error ? <View accessibilityRole="alert" style={styles.message}>
        <Text style={{ color: c.foreground }}>{error}</Text>
        <Pressable onPress={() => router.replace("/downloads")} accessibilityRole="button">
          <Text style={[styles.link, { color: c.primary }]}>Open Offline Broadcasts</Text>
        </Pressable>
      </View> : item ? <>
        {active && <LocalVideoPlayer
          key={`${item.videoId}:${cycle}`}
          videoUrl={item.localPath!}
          thumbnailUrl={item.localThumbnail ?? undefined}
          title={item.videoTitle}
          startPositionMs={position.current * 1000}
          offlinePlayback
          onProgress={onProgress}
          onEnd={onEnd}
          onError={() => {
            if (broadcastMode) {
              failedRecordings.current.add(item.videoId);
              const next = automaticBroadcast.choose(undefined, item.videoId, failedRecordings.current);
              if (next) { setSelection(next.videoId); setCycle(value => value + 1); return; }
            }
            setItem(null); setError(broadcastMode ? "No other stored broadcast can be decoded on this device." :
              "This recording could not be decoded. Re-download it while online.");
          }}
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
