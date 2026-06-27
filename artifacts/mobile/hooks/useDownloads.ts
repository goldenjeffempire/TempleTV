import { useEffect, useState, useCallback } from "react";
import { downloadManager, type DownloadItem } from "@/services/downloadManager";
import type { Sermon } from "@/types";

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let mounted = true;
    downloadManager.init().then(() => {
      if (!mounted) return;
      setDownloads(downloadManager.getAll());
      setInitialized(true);
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
    const sourceUrl = sermon.localVideoUrl ?? sermon.hlsMasterUrl;
    if (!sourceUrl || sermon.videoSource === "youtube") return;
    await downloadManager.addDownload({
      videoId: sermon.id,
      videoTitle: sermon.title,
      thumbnailUrl: sermon.thumbnailUrl,
      duration: sermon.duration,
      category: sermon.category ?? "",
      preacher: sermon.preacher ?? "",
      sourceUrl,
    });
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
      sermon.videoSource !== "youtube" &&
      !!(sermon.localVideoUrl || sermon.hlsMasterUrl)
    );
  }, []);

  const getTotalStorageBytes = useCallback(
    () => downloadManager.getTotalStorageBytes(),
    [],
  );

  const completed = downloads.filter((d) => d.status === "completed");
  const active = downloads.filter(
    (d) => d.status === "downloading" || d.status === "queued",
  );
  const failed = downloads.filter((d) => d.status === "failed");
  const paused = downloads.filter((d) => d.status === "paused");

  return {
    downloads,
    completed,
    active,
    failed,
    paused,
    initialized,
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
