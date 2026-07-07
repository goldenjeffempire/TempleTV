/**
 * DownloadManager — singleton that manages offline video downloads.
 *
 * Uses expo-file-system's DownloadResumable API which supports:
 *   • Background downloads with byte-level progress callbacks
 *   • Pause / resume via serialised resume data persisted to AsyncStorage
 *   • Cancel
 *   • Retry on failure
 *
 * Only videos with a direct `localVideoUrl` (server-hosted MP4) are downloadable.
 * YouTube videos cannot be downloaded (Terms of Service).
 *
 * Storage layout:
 *   Files: FileSystem.documentDirectory + "temple_tv_downloads/<videoId>.mp4"
 *   Metadata: AsyncStorage key "@temple_tv/downloads_v1"
 */

// expo-file-system v19+ moved the classic URI-based API to the /legacy
// sub-path. Import from there so documentDirectory, DownloadResumable,
// getInfoAsync, createDownloadResumable, makeDirectoryAsync, deleteAsync,
// and InfoOptions are all still available without deprecation runtime throws.
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "failed";

export interface DownloadItem {
  videoId: string;
  videoTitle: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  /** Original URL used to download (localVideoUrl from server) */
  sourceUrl: string;
  /** Absolute local filesystem path once completed */
  localPath: string | null;
  status: DownloadStatus;
  /** 0–1 */
  progress: number;
  totalBytes: number | null;
  downloadedBytes: number;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
  error: string | null;
}

const STORAGE_KEY = "@temple_tv/downloads_v1";
const DOWNLOADS_DIR = FileSystem.documentDirectory + "temple_tv_downloads/";
const MAX_CONCURRENT = 2;
const MAX_RETRIES = 3;

type Listener = (downloads: DownloadItem[]) => void;

class DownloadManager {
  private items: Map<string, DownloadItem> = new Map();
  private resumables: Map<string, FileSystem.DownloadResumable> = new Map();
  private listeners: Set<Listener> = new Set();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    try {
      const dirInfo = await FileSystem.getInfoAsync(DOWNLOADS_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(DOWNLOADS_DIR, { intermediates: true });
      }
    } catch {
      // Non-critical
    }

    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DownloadItem[];
        for (const item of parsed) {
          // Reset in-progress downloads to paused on app restart
          if (item.status === "downloading") {
            item.status = "paused";
          }
          this.items.set(item.videoId, item);
        }
      }
    } catch {
      // Corrupted storage — start fresh
    }

    // Verify completed files still exist on disk
    for (const [id, item] of this.items.entries()) {
      if (item.status === "completed" && item.localPath) {
        try {
          const info = await FileSystem.getInfoAsync(item.localPath);
          if (!info.exists) {
            item.status = "failed";
            item.localPath = null;
            item.error = "File was deleted from device storage";
            this.items.set(id, item);
          }
        } catch {
          // File check failed — mark as failed
          item.status = "failed";
          item.localPath = null;
          this.items.set(id, item);
        }
      }
    }

    this.initialized = true;
    await this.persist();
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAll(): DownloadItem[] {
    return Array.from(this.items.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  getItem(videoId: string): DownloadItem | undefined {
    return this.items.get(videoId);
  }

  isDownloaded(videoId: string): boolean {
    const item = this.items.get(videoId);
    return item?.status === "completed" && !!item.localPath;
  }

  getLocalPath(videoId: string): string | null {
    const item = this.items.get(videoId);
    if (item?.status === "completed") return item.localPath ?? null;
    return null;
  }

  async addDownload(video: {
    videoId: string;
    videoTitle: string;
    thumbnailUrl: string;
    duration: string;
    category: string;
    preacher: string;
    sourceUrl: string;
  }): Promise<void> {
    await this.init();
    if (this.items.has(video.videoId)) return;

    const item: DownloadItem = {
      ...video,
      localPath: null,
      status: "queued",
      progress: 0,
      totalBytes: null,
      downloadedBytes: 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      retryCount: 0,
      error: null,
    };
    this.items.set(video.videoId, item);
    await this.persist();
    this.notify();
    void this.processQueue();
  }

  async pauseDownload(videoId: string): Promise<void> {
    await this.init();
    const item = this.items.get(videoId);
    if (!item || item.status !== "downloading") return;

    const resumable = this.resumables.get(videoId);
    if (resumable) {
      try {
        const pauseResult = await resumable.pauseAsync();
        // Persist resume data so we can resume even after app restart
        const updatedItem: DownloadItem = {
          ...item,
          status: "paused",
          error: null,
        };
        // Store resume data alongside item in a separate key
        if (pauseResult.resumeData) {
          await AsyncStorage.setItem(
            `@temple_tv/dl_resume_${videoId}`,
            pauseResult.resumeData,
          );
        }
        this.items.set(videoId, updatedItem);
        this.resumables.delete(videoId);
        await this.persist();
        this.notify();
      } catch {
        // If pause fails, mark as paused anyway (will retry from start)
        this.items.set(videoId, { ...item, status: "paused" });
        this.resumables.delete(videoId);
        await this.persist();
        this.notify();
      }
    }
  }

  async resumeDownload(videoId: string): Promise<void> {
    await this.init();
    const item = this.items.get(videoId);
    if (!item || (item.status !== "paused" && item.status !== "failed")) return;

    this.items.set(videoId, { ...item, status: "queued", error: null });
    await this.persist();
    this.notify();
    void this.processQueue();
  }

  async cancelDownload(videoId: string): Promise<void> {
    await this.init();
    const resumable = this.resumables.get(videoId);
    if (resumable) {
      try { await resumable.cancelAsync(); } catch { /* ignore */ }
      this.resumables.delete(videoId);
    }
    const item = this.items.get(videoId);
    if (item?.localPath) {
      try { await FileSystem.deleteAsync(item.localPath, { idempotent: true }); } catch { /* ignore */ }
    }
    await AsyncStorage.removeItem(`@temple_tv/dl_resume_${videoId}`).catch(() => {});
    this.items.delete(videoId);
    await this.persist();
    this.notify();
    void this.processQueue();
  }

  async retryDownload(videoId: string): Promise<void> {
    await this.init();
    const item = this.items.get(videoId);
    if (!item) return;
    this.items.set(videoId, {
      ...item,
      status: "queued",
      progress: 0,
      downloadedBytes: 0,
      error: null,
    });
    await this.persist();
    this.notify();
    void this.processQueue();
  }

  async clearCompleted(): Promise<void> {
    await this.init();
    const toDelete = Array.from(this.items.values()).filter(
      (i) => i.status === "completed",
    );
    for (const item of toDelete) {
      if (item.localPath) {
        try { await FileSystem.deleteAsync(item.localPath, { idempotent: true }); } catch { /* ignore */ }
      }
      this.items.delete(item.videoId);
    }
    await this.persist();
    this.notify();
  }

  async clearAll(): Promise<void> {
    await this.init();
    // Cancel active downloads first
    for (const [videoId, resumable] of this.resumables.entries()) {
      try { await resumable.cancelAsync(); } catch { /* ignore */ }
      this.resumables.delete(videoId);
    }
    // Delete all files
    for (const item of this.items.values()) {
      if (item.localPath) {
        try { await FileSystem.deleteAsync(item.localPath, { idempotent: true }); } catch { /* ignore */ }
      }
      await AsyncStorage.removeItem(`@temple_tv/dl_resume_${item.videoId}`).catch(() => {});
    }
    this.items.clear();
    await this.persist();
    this.notify();
  }

  async getTotalStorageBytes(): Promise<number> {
    let total = 0;
    for (const item of this.items.values()) {
      if (item.status === "completed" && item.localPath) {
        try {
          // In expo-file-system/legacy, InfoOptions only supports { md5 } —
          // the size field is always present in FileInfo when the file exists.
          const info = await FileSystem.getInfoAsync(item.localPath);
          if (info.exists && "size" in info) {
            total += (info as { size: number }).size;
          }
        } catch { /* ignore */ }
      }
    }
    return total;
  }

  private activeCount(): number {
    return Array.from(this.items.values()).filter(
      (i) => i.status === "downloading",
    ).length;
  }

  private async processQueue(): Promise<void> {
    const queued = Array.from(this.items.values())
      .filter((i) => i.status === "queued")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    for (const item of queued) {
      if (this.activeCount() >= MAX_CONCURRENT) break;
      void this.startDownload(item.videoId);
    }
  }

  private async startDownload(videoId: string): Promise<void> {
    const item = this.items.get(videoId);
    if (!item) return;

    const localPath = DOWNLOADS_DIR + videoId + ".mp4";
    this.items.set(videoId, { ...item, status: "downloading", localPath, error: null });
    await this.persist();
    this.notify();

    try {
      // Try to resume from saved resume data first
      const resumeData = await AsyncStorage.getItem(`@temple_tv/dl_resume_${videoId}`).catch(() => null);

      let resumable: FileSystem.DownloadResumable;

      if (resumeData) {
        resumable = FileSystem.createDownloadResumable(
          item.sourceUrl,
          localPath,
          {},
          (progress) => this.onProgress(videoId, progress),
          resumeData,
        );
      } else {
        resumable = FileSystem.createDownloadResumable(
          item.sourceUrl,
          localPath,
          {},
          (progress) => this.onProgress(videoId, progress),
        );
      }

      this.resumables.set(videoId, resumable);

      const result = resumeData
        ? await resumable.resumeAsync()
        : await resumable.downloadAsync();

      this.resumables.delete(videoId);
      await AsyncStorage.removeItem(`@temple_tv/dl_resume_${videoId}`).catch(() => {});

      const current = this.items.get(videoId);
      if (!current || current.status === "paused") {
        // Was paused during the download — respect that
        return;
      }

      if (!result || !result.uri) {
        throw new Error("Download produced no output file");
      }

      if (result.status !== 200) {
        throw new Error(`Server returned status ${result.status}`);
      }

      this.items.set(videoId, {
        ...current,
        status: "completed",
        localPath: result.uri,
        progress: 1,
        completedAt: new Date().toISOString(),
        error: null,
      });
    } catch (err: unknown) {
      const current = this.items.get(videoId);
      if (!current) return;

      // Don't overwrite a paused state set by pauseDownload()
      if (current.status === "paused") return;

      const message = err instanceof Error ? err.message : "Download failed";
      const retryCount = (current.retryCount ?? 0) + 1;

      if (retryCount < MAX_RETRIES) {
        // Auto-retry with brief delay
        this.items.set(videoId, {
          ...current,
          status: "queued",
          retryCount,
          error: null,
        });
        await this.persist();
        this.notify();
        await new Promise<void>((r) => setTimeout(r, 2000 * retryCount));
        void this.processQueue();
        return;
      }

      this.items.set(videoId, {
        ...current,
        status: "failed",
        retryCount,
        error: message,
      });
      this.resumables.delete(videoId);
    }

    await this.persist();
    this.notify();
    void this.processQueue();
  }

  private onProgress(
    videoId: string,
    progress: FileSystem.DownloadProgressData,
  ): void {
    const item = this.items.get(videoId);
    if (!item) return;
    const { totalBytesExpectedToWrite, totalBytesWritten } = progress;
    const pct =
      totalBytesExpectedToWrite > 0
        ? totalBytesWritten / totalBytesExpectedToWrite
        : 0;
    this.items.set(videoId, {
      ...item,
      progress: Math.min(pct, 1),
      downloadedBytes: totalBytesWritten,
      totalBytes: totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : null,
    });
    this.notify();
  }

  private notify(): void {
    const snapshot = this.getAll();
    for (const l of this.listeners) {
      try { l(snapshot); } catch { /* ignore */ }
    }
  }

  private async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.getAll()));
    } catch { /* Non-critical */ }
  }
}

export const downloadManager = new DownloadManager();
