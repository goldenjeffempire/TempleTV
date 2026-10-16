/**
 * Native adapter for verified, app-private recording downloads.
 * No native dependency added: Expo FileSystem handles transfer and disk IO.
 */
import * as FileSystem from "expo-file-system/legacy";
import { File } from "expo-file-system";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { sha256 } from "@noble/hashes/sha2.js";
import { getApiBase } from "../lib/apiBase";
import { OfflineDownloadEngine } from "./offlineDownloadEngine";
import type { OfflineGrant, OfflineIO } from "./offlineTypes";
export type { DownloadItem, DownloadStatus } from "./offlineTypes";

const STORAGE_KEY = "@temple_tv/downloads_v1";
const directory = (FileSystem.documentDirectory ?? "") + "temple_tv_downloads/";

function appMediaUrl(value: string): string {
  const base = getApiBase();
  const url = new URL(value, base);
  if (!base || (!__DEV__ && url.protocol !== "https:") || url.origin !== new URL(base).origin ||
      !/^\/api\/(?:v1\/)?uploads\/[a-zA-Z0-9/_-]+\.(mp4|m4v|mov)$/i.test(url.pathname) ||
      url.search || url.hash || url.username || url.password) {
    throw Object.assign(new Error("Only authorized app-hosted recordings can be downloaded"), { permanent: true });
  }
  return url.toString();
}

const io: OfflineIO = {
  directory,
  async prepare() {
    if (Platform.OS === "web" || !FileSystem.documentDirectory) {
      throw new Error("Offline downloads require the installed Android or iOS app.");
    }
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  },
  async load() {
    const value = await AsyncStorage.getItem(STORAGE_KEY);
    if (!value) return [];
    try { return JSON.parse(value); } catch {
      // Leave malformed metadata on disk for diagnosis; do not silently erase
      // an existing offline library or its media files.
      throw new Error("Offline library metadata is damaged. Please contact support before clearing app data.");
    }
  },
  async save(items) { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items)); },
  async list() { return FileSystem.readDirectoryAsync(directory); },
  async info(path) {
    const info = await FileSystem.getInfoAsync(path);
    return { exists: info.exists, size: info.exists && !info.isDirectory ? info.size : 0 };
  },
  async freeBytes() { return FileSystem.getFreeDiskStorageAsync(); },
  async remove(path) { await FileSystem.deleteAsync(path, { idempotent: true }); },
  async move(from, to) { await FileSystem.moveAsync({ from, to }); },
  async hash(path, stopped) {
    // Native file handle reads bounded byte arrays, never a full base64 movie.
    // SHA-256 is incremental; the UI gets a scheduling turn between 1 MiB reads.
    const handle = new File(path).open();
    const hash = sha256.create();
    try {
      while ((handle.offset ?? 0) < (handle.size ?? 0)) {
        if (stopped()) throw new Error("Verification cancelled");
        hash.update(handle.readBytes(Math.min(1024 * 1024, (handle.size ?? 0) - (handle.offset ?? 0))));
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
    } finally { handle.close(); hash.destroy(); }
  },
  async authorize(id) {
    const response = await fetch(`${getApiBase()}/api/videos/${encodeURIComponent(id)}/offline`, {
      signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!response.ok) {
      throw Object.assign(new Error(response.status === 409
        ? "This recording is not approved for verified offline viewing."
        : `Offline authorization HTTP ${response.status}`),
      { permanent: [400, 401, 403, 404, 409, 410].includes(response.status) });
    }
    const grant = await response.json() as OfflineGrant;
    if (grant.policy !== "public-recording-7-days" || grant.videoId !== id ||
        !["videoTitle", "thumbnailUrl", "duration", "category", "preacher", "sourceUrl", "expiresAt"]
          .every(key => typeof grant[key as keyof OfflineGrant] === "string") ||
        (grant.sha256 !== null && !/^[a-f0-9]{64}$/i.test(grant.sha256)) ||
        !Number.isSafeInteger(grant.sizeBytes) || grant.sizeBytes <= 0 ||
        !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) {
      throw Object.assign(new Error("Invalid offline recording authorization"), { permanent: true });
    }
    grant.sourceUrl = appMediaUrl(grant.sourceUrl);
    return grant;
  },
  async thumbnail(value, path) {
    const base = getApiBase();
    const url = new URL(value, base);
    // Never forward credentials to artwork hosts, and never follow arbitrary
    // third-party URLs for offline recordings.
    if (url.origin !== new URL(base).origin || url.protocol !== new URL(base).protocol) return false;
    const temporary = path + ".part";
    const task = FileSystem.createDownloadResumable(url.toString(), temporary, {}, progress => {
      if (progress.totalBytesWritten > 10 * 1024 * 1024) void task.cancelAsync().catch(() => {});
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        task.downloadAsync(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void task.cancelAsync().catch(() => {});
            reject(new Error("Artwork download timed out"));
          }, 10_000);
        }),
      ]);
      const info = await FileSystem.getInfoAsync(temporary);
      if (result?.status !== 200 || !info.exists || info.size <= 0 || info.size > 10 * 1024 * 1024) return false;
      await FileSystem.moveAsync({ from: temporary, to: path });
      return true;
    } finally {
      if (timer) clearTimeout(timer);
      await task.cancelAsync().catch(() => {});
      await FileSystem.deleteAsync(temporary, { idempotent: true });
    }
  },
  task(url, path, resumeData, progress) {
    const resumable = FileSystem.createDownloadResumable(appMediaUrl(url), path, {},
      update => progress(update.totalBytesWritten), resumeData);
    return {
      async run() { return resumeData ? resumable.resumeAsync() : resumable.downloadAsync(); },
      async pause() { return (await resumable.pauseAsync()).resumeData; },
      async cancel() { await resumable.cancelAsync(); },
    };
  },
};

export const downloadManager = new OfflineDownloadEngine(io);
