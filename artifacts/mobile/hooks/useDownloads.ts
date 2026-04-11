import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type { Sermon } from "@/types";

let FileSystem: any = null;
try {
  FileSystem = require("expo-file-system");
} catch {
  FileSystem = null;
}

const STORAGE_KEY = "@temple_tv/downloads";

export interface DownloadRecord {
  sermon: Sermon;
  localPath: string;
  downloadedAt: string;
  fileSizeBytes?: number;
}

export interface DownloadProgress {
  sermonId: string;
  progress: number;
  status: "downloading" | "done" | "error" | "paused";
}

function isSupported(): boolean {
  return Platform.OS !== "web" && FileSystem !== null;
}

function getDownloadDir(): string {
  if (!FileSystem) return "";
  return `${FileSystem.documentDirectory}temple_tv_downloads/`;
}

async function ensureDir() {
  if (!FileSystem) return;
  const dir = getDownloadDir();
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function loadRecords(): Promise<DownloadRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DownloadRecord[];
  } catch {
    return [];
  }
}

async function saveRecords(records: DownloadRecord[]) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const resumableRefs = useRef<Record<string, any>>({});
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadRecords().then(setDownloads).catch(() => {});
  }, []);

  const isDownloaded = useCallback(
    (sermonId: string) => downloads.some((d) => d.sermon.id === sermonId),
    [downloads],
  );

  const getLocalPath = useCallback(
    (sermonId: string) => downloads.find((d) => d.sermon.id === sermonId)?.localPath ?? null,
    [downloads],
  );

  const getProgress = useCallback(
    (sermonId: string) => progress[sermonId] ?? null,
    [progress],
  );

  const downloadSermon = useCallback(
    async (sermon: Sermon) => {
      if (!isSupported()) return;
      if (!sermon.localVideoUrl) return;
      if (isDownloaded(sermon.id)) return;
      if (progress[sermon.id]?.status === "downloading") return;

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      if (!domain) return;

      const rawUrl = sermon.localVideoUrl;
      const downloadUrl = rawUrl.startsWith("http")
        ? rawUrl
        : `https://${domain}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;

      setProgress((prev) => ({
        ...prev,
        [sermon.id]: { sermonId: sermon.id, progress: 0, status: "downloading" },
      }));

      try {
        await ensureDir();
        const ext = downloadUrl.split("?")[0].split(".").pop() ?? "mp4";
        const filename = `${sermon.id}.${ext}`;
        const destPath = `${getDownloadDir()}${filename}`;

        const resumable = FileSystem.createDownloadResumable(
          downloadUrl,
          destPath,
          {},
          (downloadProgressEvent: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => {
            const { totalBytesWritten, totalBytesExpectedToWrite } = downloadProgressEvent;
            const pct =
              totalBytesExpectedToWrite > 0
                ? Math.round((totalBytesWritten / totalBytesExpectedToWrite) * 100)
                : 0;
            setProgress((prev) => ({
              ...prev,
              [sermon.id]: { sermonId: sermon.id, progress: pct, status: "downloading" },
            }));
          },
        );

        resumableRefs.current[sermon.id] = resumable;

        const result = await resumable.downloadAsync();

        if (!result?.uri) throw new Error("Download failed — no URI returned");

        const info = await FileSystem.getInfoAsync(result.uri);
        const record: DownloadRecord = {
          sermon,
          localPath: result.uri,
          downloadedAt: new Date().toISOString(),
          fileSizeBytes: info.exists && "size" in info ? (info as any).size : undefined,
        };

        const updated = await loadRecords();
        const next = [record, ...updated.filter((d) => d.sermon.id !== sermon.id)];
        await saveRecords(next);
        setDownloads(next);

        setProgress((prev) => ({
          ...prev,
          [sermon.id]: { sermonId: sermon.id, progress: 100, status: "done" },
        }));

        delete resumableRefs.current[sermon.id];
      } catch {
        setProgress((prev) => ({
          ...prev,
          [sermon.id]: { sermonId: sermon.id, progress: 0, status: "error" },
        }));
        delete resumableRefs.current[sermon.id];
      }
    },
    [isDownloaded, progress],
  );

  const deleteDownload = useCallback(
    async (sermonId: string) => {
      if (!isSupported()) return;

      resumableRefs.current[sermonId]?.pauseAsync().catch(() => {});
      delete resumableRefs.current[sermonId];

      const record = downloads.find((d) => d.sermon.id === sermonId);
      if (record?.localPath) {
        try {
          await FileSystem.deleteAsync(record.localPath, { idempotent: true });
        } catch {}
      }

      const next = downloads.filter((d) => d.sermon.id !== sermonId);
      await saveRecords(next);
      setDownloads(next);

      setProgress((prev) => {
        const updated = { ...prev };
        delete updated[sermonId];
        return updated;
      });
    },
    [downloads],
  );

  const totalSizeBytes = downloads.reduce((acc, d) => acc + (d.fileSizeBytes ?? 0), 0);

  return {
    downloads,
    isDownloaded,
    getLocalPath,
    getProgress,
    downloadSermon,
    deleteDownload,
    totalSizeBytes,
    isSupported: isSupported(),
  };
}
