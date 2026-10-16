import { useEffect, useState, useCallback } from "react";
import { AppState, Platform } from "react-native";
import { downloadManager, type DownloadItem } from "@/services/downloadManager";
import type { Sermon } from "@/types";
import { useNetworkStatus } from "./useNetworkStatus";
import { automaticBroadcast } from "@/services/automaticBroadcast";
import type { BroadcastPreparation } from "@/services/offlineBroadcastEngine";
import * as Network from "expo-network";
import Constants from "expo-constants";
import { mayPrepareBroadcast } from "@/lib/broadcastDownloadPolicy";

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isOnline } = useNetworkStatus();
  const [broadcastPreparation, setBroadcastPreparation] = useState<BroadcastPreparation>(
    { total: 0, ready: 0, preparing: false, error: null });
  const [automaticAllowed, setAutomaticAllowed] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    let mounted = true;
    let generation = 0;
    const allowCellular = Constants.expoConfig?.extra?.offlineBroadcast?.allowCellular === true;
    const apply = (network: Network.NetworkState) => {
      const allowed = mayPrepareBroadcast(isOnline, network, allowCellular);
      setAutomaticAllowed(allowed);
      void downloadManager.setAutomaticTransfersAllowed(allowed).catch(e =>
        setError(e instanceof Error ? e.message : "Automatic broadcast transfer could not be paused"));
    };
    const request = ++generation;
    void Network.getNetworkStateAsync().then(network => {
      if (mounted && request === generation) apply(network);
    }).catch(() => { if (mounted) apply({}); });
    const subscription = Network.addNetworkStateListener(network => {
      generation++; if (mounted) apply(network);
    });
    return () => {
      mounted = false; subscription.remove();
      void downloadManager.setAutomaticTransfersAllowed(false).catch(() => {});
    };
  }, [isOnline]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const update = () => setBroadcastPreparation(automaticBroadcast.state());
    const unsubscribe = automaticBroadcast.subscribe(update);
    const downloadsChanged = downloadManager.subscribe(update);
    void automaticBroadcast.init().then(update).catch(e => setBroadcastPreparation(
      { total: 0, ready: 0, preparing: false, error: e instanceof Error ? e.message : "Broadcast storage unavailable" }));
    return () => { unsubscribe(); downloadsChanged(); };
  }, []);

  useEffect(() => {
    const update = (active: boolean) => {
      if (Platform.OS === "web") return;
      automaticBroadcast.setActive(isOnline && automaticAllowed && active);
      void downloadManager.setConnectivity(isOnline, active).catch(e =>
        setError(e instanceof Error ? e.message : "Offline library could not be opened"));
      if (isOnline && automaticAllowed && active) void automaticBroadcast.sync();
    };
    update(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", state => update(state === "active"));
    // One app-wide owner, no network traffic while backgrounded/offline.
    const poll = setInterval(() => {
      if (AppState.currentState === "active" && isOnline && automaticAllowed) void automaticBroadcast.sync();
    }, 5 * 60_000);
    return () => { subscription.remove(); clearInterval(poll); automaticBroadcast.setActive(false); };
  }, [isOnline, automaticAllowed]);

  useEffect(() => {
    let mounted = true;
    downloadManager.init().then(() => {
      if (!mounted) return;
      setDownloads(downloadManager.getAll());
      setInitialized(true);
    }).catch((e) => {
      // init() wraps all failures internally — this catch guards against any
      // unexpected throw (e.g. storage permission error on a new OS version)
      // and still marks the hook as initialized so UI doesn't hang forever.
      if (mounted) { setInitialized(true); setError(e instanceof Error ? e.message : "Offline library could not be opened"); }
    });
    const unsub = downloadManager.subscribe((updated) => {
      if (mounted) setDownloads(updated);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const addDownload = useCallback(async (sermon: Sermon) => {
    const sourceUrl = sermon.localVideoUrl;
    if (!sourceUrl || sermon.videoSource === "youtube" || /\.m3u8(?:[?#]|$)/i.test(sourceUrl)) {
      throw new Error("Only authorized app-hosted recordings can be downloaded");
    }
    try {
      await downloadManager.addDownload({
        videoId: sermon.id,
        videoTitle: sermon.title,
        thumbnailUrl: sermon.thumbnailUrl,
        duration: sermon.duration,
        category: sermon.category ?? "",
        preacher: sermon.preacher ?? "",
        sourceUrl,
      });
    } catch (err) {
      if (__DEV__) console.error("[useDownloads] addDownload failed:", err);
      // Re-throw so the UI can surface an error message (e.g. "Storage full").
      throw err;
    }
  }, []);

  const pauseDownload = useCallback(
    (videoId: string) => downloadManager.pauseDownload(videoId),
    [],
  );

  const resumeDownload = useCallback(
    (videoId: string) => downloadManager.resumeDownload(videoId),
    [],
  );

  const cancelDownload = useCallback(
    (videoId: string) => downloadManager.cancelDownload(videoId),
    [],
  );

  const retryDownload = useCallback(
    (videoId: string) => downloadManager.retryDownload(videoId),
    [],
  );

  const clearCompleted = useCallback(() => downloadManager.clearCompleted(), []);

  const clearAll = useCallback(() => downloadManager.clearAll(), []);

  const isDownloaded = useCallback(
    (videoId: string) => downloadManager.isDownloaded(videoId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [downloads], // re-evaluate when downloads list changes
  );

  const getLocalPath = useCallback(
    (videoId: string) => downloadManager.getLocalPath(videoId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [downloads],
  );

  const getDownloadItem = useCallback(
    (videoId: string) => downloads.find((d) => d.videoId === videoId),
    [downloads],
  );

  const isDownloadable = useCallback((sermon: Sermon): boolean => {
    return (
      sermon.videoSource === "local" &&
      !!sermon.localVideoUrl && !/^(file:|content:)|\.m3u8(?:[?#]|$)/i.test(sermon.localVideoUrl)
    );
  }, []);

  const getTotalStorageBytes = useCallback(
    () => downloadManager.getTotalStorageBytes(),
    [],
  );

  const completed = downloads.filter((d) => d.status === "completed");
  const active = downloads.filter(
    (d) => ["downloading", "queued", "verifying"].includes(d.status),
  );
  const failed = downloads.filter((d) => d.status === "failed");
  const paused = downloads.filter((d) => d.status === "paused");

  return {
    downloads,
    broadcastPreparation: { ...broadcastPreparation,
      waitingForWifi: !automaticAllowed && broadcastPreparation.ready < broadcastPreparation.total },
    automaticTransfersAllowed: automaticAllowed,
    completed,
    active,
    failed,
    paused,
    initialized,
    error,
    addDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    clearCompleted,
    clearAll,
    isDownloaded,
    getLocalPath,
    getDownloadItem,
    isDownloadable,
    getTotalStorageBytes,
  };
}
