export type DownloadStatus = "queued" | "downloading" | "verifying" | "paused" | "completed" | "failed";

export interface DownloadItem {
  videoId: string;
  videoTitle: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  sourceUrl: string;
  localPath: string | null;
  status: DownloadStatus;
  progress: number;
  totalBytes: number | null;
  downloadedBytes: number;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
  error: string | null;
  sha256?: string;
  expiresAt?: string;
  checkedAt?: number;
  localThumbnail?: string | null;
  resumeData?: string;
  autoResume?: boolean;
  retryAt?: number;
  positionSecs?: number;
  automaticBroadcast?: boolean;
  offlinePolicy?: "public-recording-7-days" | "public-broadcast-recording";
}

export interface OfflineGrant {
  videoId: string;
  videoTitle: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  sourceUrl: string;
  sizeBytes: number;
  sha256: string | null;
  expiresAt: string | null;
  policy: "public-recording-7-days" | "public-broadcast-recording";
}

export interface OfflineTask {
  run(): Promise<{ status: number; uri: string } | undefined>;
  pause(): Promise<string | undefined>;
  cancel(): Promise<void>;
}

/** Native IO is isolated so lifecycle/state transitions can be exercised in Node. */
export interface OfflineIO {
  directory: string;
  load(): Promise<unknown>;
  save(items: DownloadItem[]): Promise<void>;
  prepare(): Promise<void>;
  list(): Promise<string[]>;
  info(path: string): Promise<{ exists: boolean; size: number }>;
  freeBytes(): Promise<number>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  hash(path: string, stopped: () => boolean): Promise<string>;
  authorize(id: string, broadcast?: boolean): Promise<OfflineGrant>;
  thumbnail(url: string, path: string): Promise<boolean>;
  task(url: string, path: string, resumeData: string | undefined,
    progress: (written: number) => void): OfflineTask;
}

export function isSafeVideoId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

export function usableOfflineGrant(item: DownloadItem, now = Date.now()): boolean {
  return item.status === "completed" && !!item.localPath &&
    /^[a-f0-9]{64}$/i.test(item.sha256 ?? "") &&
    (item.offlinePolicy === "public-broadcast-recording" ||
      (Number.isFinite(Date.parse(item.expiresAt ?? "")) && Date.parse(item.expiresAt!) > now)) &&
    (item.totalBytes ?? 0) > 0;
}

export function validOfflineAccess(grant: OfflineGrant, broadcast = false): boolean {
  if (broadcast) return grant.policy === "public-broadcast-recording" && grant.expiresAt === null;
  return grant.policy === "public-recording-7-days" &&
    typeof grant.expiresAt === "string" && Number.isFinite(Date.parse(grant.expiresAt)) &&
    Date.parse(grant.expiresAt) > Date.now();
}
