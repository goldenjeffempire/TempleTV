import {
  isSafeVideoId, usableOfflineGrant, validOfflineAccess,
  type DownloadItem, type OfflineIO, type OfflineTask,
} from "./offlineTypes";

type Worker = { stopped: boolean; task?: OfflineTask; done?: Promise<void>; parking?: Promise<void> };
const RESERVE = 32 * 1024 * 1024;

/** Durable two-slot queue. All native work is fenced by a per-attempt worker. */
export class OfflineDownloadEngine {
  private items = new Map<string, DownloadItem>();
  private workers = new Map<string, Worker>();
  private listeners = new Set<(items: DownloadItem[]) => void>();
  private initPromise?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private online = false;
  private foreground = true;
  private timer?: ReturnType<typeof setTimeout>;
  private syncing = false;
  private lastNotify = new Map<string, number>();
  private automaticTransfersAllowed = false;
  private broadcastLineup = new Set<string>();
  private broadcastLineupInitialized = false;
  private playbackPins = new Set<string>();

  constructor(private io: OfflineIO) {}
  private path(id: string, suffix = ".mp4"): string {
    if (!isSafeVideoId(id)) throw new Error("Invalid recording identifier");
    return `${this.io.directory}${id}${suffix}`;
  }
  init(): Promise<void> { return this.initPromise ??= this.restore(); }
  private async restore(): Promise<void> {
    await this.io.prepare();
    const raw = await this.io.load();
    if (Array.isArray(raw)) for (const value of raw) {
      const item = value as DownloadItem;
      if (!item || !isSafeVideoId(item.videoId) || typeof item.videoTitle !== "string" ||
          typeof item.createdAt !== "string") continue;
      if (!["queued", "paused", "downloading", "verifying", "completed", "failed"].includes(item.status)) continue;
      // Do not trust arbitrary paths from persisted metadata.
      item.localPath = item.status === "completed" ? this.path(item.videoId) : null;
      item.localThumbnail = item.localThumbnail === this.path(item.videoId, ".jpg") ? item.localThumbnail : null;
      if (item.status === "downloading" || item.status === "verifying") {
        item.status = "paused"; item.autoResume = true;
      }
      if (item.status === "completed") {
        const info = await this.io.info(this.path(item.videoId));
        if (!usableOfflineGrant(item) || !info.exists || info.size !== item.totalBytes) {
          item.status = "failed"; item.localPath = null;
          item.error = "Offline copy needs verification or renewal. Connect and tap Retry.";
        }
      }
      this.items.set(item.videoId, item);
    }
    // Only our managed filenames are considered; never traverse outside the directory.
    const retained = new Set([...this.items.keys()].map(id => `${id}.part`));
    for (const name of await this.io.list()) {
      if (/^[\w-]+(?:\.jpg)?\.part$/.test(name) && !retained.has(name)) await this.io.remove(this.io.directory + name);
    }
    await this.persist(); this.notify(); this.processQueue();
  }
  subscribe(listener: (items: DownloadItem[]) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  getAll(): DownloadItem[] {
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(i => ({ ...i }));
  }
  getItem(id: string): DownloadItem | undefined { const i = this.items.get(id); return i && { ...i }; }
  isDownloaded(id: string): boolean { const i = this.items.get(id); return !!i && usableOfflineGrant(i); }
  getLocalPath(id: string): string | null { return this.isDownloaded(id) ? this.path(id) : null; }
  private notify(): void {
    const snapshot = this.getAll();
    for (const listener of this.listeners) { try { listener(snapshot); } catch { /* isolated UI subscriber */ } }
  }
  private persist(): Promise<void> {
    const snapshot = this.getAll();
    const next = this.writes.catch(() => {}).then(() => this.io.save(snapshot));
    this.writes = next;
    return next;
  }
  private async changed(): Promise<void> { this.notify(); await this.persist(); }

  async addDownload(video: Pick<DownloadItem, "videoId" | "videoTitle" | "thumbnailUrl" | "duration" | "category" | "preacher" | "sourceUrl"> & { automaticBroadcast?: boolean }): Promise<void> {
    await this.init();
    this.path(video.videoId);
    if (this.items.has(video.videoId)) return;
    if (this.workers.has(video.videoId)) throw new Error("Previous download is still stopping");
    this.items.set(video.videoId, { ...video, sourceUrl: "", localPath: null,
      status: "queued", progress: 0, totalBytes: null, downloadedBytes: 0,
      createdAt: new Date().toISOString(), completedAt: null, retryCount: 0, error: null });
    try { await this.changed(); } catch (error) { this.items.delete(video.videoId); this.notify(); throw error; }
    this.processQueue();
  }
  /** Upgrade an existing manual copy without deleting or retransferring it. */
  async prepareBroadcast(video: Parameters<OfflineDownloadEngine["addDownload"]>[0]): Promise<void> {
    await this.init();
    const existing = this.items.get(video.videoId);
    if (!existing) return this.addDownload({ ...video, automaticBroadcast: true });
    if (existing.offlinePolicy === "public-broadcast-recording" &&
        !["failed", "paused"].includes(existing.status)) return;
    // Never mutate the authorization mode of an in-flight manual transfer.
    if (this.workers.has(video.videoId)) return;
    existing.automaticBroadcast = true;
    existing.status = "queued"; existing.error = null; existing.retryAt = 0;
    existing.retryCount = 0; existing.autoResume = false;
    await this.changed(); this.processQueue();
  }
  async setAutomaticTransfersAllowed(allowed: boolean): Promise<void> {
    this.automaticTransfersAllowed = allowed;
    await this.init();
    if (!allowed) {
      await Promise.all([...this.workers.keys()].filter(id => this.items.get(id)?.automaticBroadcast)
        .map(id => this.pause(id, true)));
    } else {
      for (const item of this.items.values()) if (item.automaticBroadcast && item.status === "paused" && item.autoResume) {
        item.status = "queued"; item.autoResume = false;
      }
      await this.changed(); this.processQueue();
    }
  }
  setBroadcastLineup(ids: string[]): void {
    this.broadcastLineup = new Set(ids); this.broadcastLineupInitialized = true;
  }
  pinForPlayback(id: string): () => void {
    this.playbackPins.add(id);
    return () => { this.playbackPins.delete(id); };
  }
  private async reclaimOutdatedBroadcasts(requiredFree: number): Promise<void> {
    if (!this.broadcastLineupInitialized) return;
    const outdated = [...this.items.values()].filter(item => item.automaticBroadcast &&
      item.status === "completed" && !this.broadcastLineup.has(item.videoId) &&
      !this.playbackPins.has(item.videoId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of outdated) {
      if (await this.io.freeBytes() >= requiredFree) break;
      await this.cancelDownload(item.videoId, true);
    }
  }
  async setConnectivity(online: boolean, foreground = this.foreground): Promise<void> {
    this.online = online; this.foreground = foreground;
    await this.init();
    if (!online || !foreground) {
      clearTimeout(this.timer);
      await Promise.all([...this.workers.keys()].map(id => this.pause(id, true)));
      return;
    }
    for (const item of this.items.values()) if (item.status === "paused" && item.autoResume) {
      item.status = "queued"; item.autoResume = false;
    }
    await this.changed();
    this.processQueue();
    void this.refreshAccess().catch(() => { /* connectivity owner surfaces persistence errors on its next update */ });
  }
  async pauseDownload(id: string): Promise<void> { await this.init(); await this.pause(id, false); }
  private async pause(id: string, automatic: boolean): Promise<void> {
    const item = this.items.get(id);
    if (!item || !["queued", "downloading", "verifying"].includes(item.status)) return;
    item.status = "paused"; item.autoResume = automatic;
    const worker = this.workers.get(id);
    if (worker) worker.stopped = true;
    const park = async () => {
      await this.changed();
      if (worker?.task) {
        try {
          const resumeData = await worker.task.pause();
          if (this.items.get(id) === item && resumeData) item.resumeData = resumeData;
        } catch {
          await worker.task.cancel().catch(() => {});
          if (this.items.get(id) === item) item.resumeData = undefined;
        }
        await this.changed();
      }
    };
    if (worker) { worker.parking = park(); await worker.parking; }
    else await park();
  }
  async resumeDownload(id: string): Promise<void> {
    await this.init();
    const item = this.items.get(id);
    if (!item || !["paused", "failed"].includes(item.status)) return;
    item.status = "queued"; item.error = null; item.retryAt = 0; item.retryCount = 0;
    await this.changed(); this.processQueue();
  }
  async retryDownload(id: string): Promise<void> { await this.resumeDownload(id); }
  async cancelDownload(id: string, onlyIfUnpinned = false): Promise<void> {
    await this.init();
    if (onlyIfUnpinned && this.playbackPins.has(id)) return;
    const worker = this.workers.get(id);
    if (worker) worker.stopped = true;
    this.items.delete(id); this.lastNotify.delete(id);
    await this.changed();
    await worker?.task?.cancel().catch(() => {});
    await worker?.done;
    for (const suffix of [".part", ".mp4", ".jpg"]) await this.io.remove(this.path(id, suffix));
    this.processQueue();
  }
  async clearCompleted(): Promise<void> {
    for (const item of this.getAll()) if (item.status === "completed") await this.cancelDownload(item.videoId);
  }
  async clearAll(): Promise<void> { for (const item of this.getAll()) await this.cancelDownload(item.videoId); }
  async getTotalStorageBytes(): Promise<number> {
    await this.init();
    let bytes = 0;
    for (const item of this.items.values()) for (const suffix of [".mp4", ".part", ".jpg"]) {
      bytes += (await this.io.info(this.path(item.videoId, suffix))).size;
    }
    return bytes;
  }
  private processQueue(): void {
    clearTimeout(this.timer);
    if (!this.online || !this.foreground) return;
    const queued = [...this.items.values()].filter(i => i.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of queued) {
      if (this.workers.size >= 2) break;
      if (item.automaticBroadcast && !this.automaticTransfersAllowed) continue;
      // A full broadcast can be many GB. One automatic transfer at a time
      // bounds radio, disk and origin pressure without slowing manual VOD.
      if (item.automaticBroadcast && [...this.workers.keys()].some(id => this.items.get(id)?.automaticBroadcast)) continue;
      if (this.workers.has(item.videoId) || (item.retryAt ?? 0) > Date.now()) continue;
      const worker: Worker = { stopped: false };
      this.workers.set(item.videoId, worker);
      item.status = "downloading";
      worker.done = this.run(item, worker).catch(error => {
        // Persistence failures are surfaced, not an unhandled background rejection.
        if (this.items.get(item.videoId) === item && !worker.stopped) {
          item.status = "failed"; item.error = error instanceof Error ? error.message : "Download state could not be saved";
          this.notify();
        }
      }).finally(async () => {
        // A resolved native run can race pauseAsync's checkpoint write. Keep
        // its queue slot fenced until the checkpoint has been persisted.
        await worker.parking?.catch(() => {});
        if (this.workers.get(item.videoId) === worker) this.workers.delete(item.videoId);
        this.lastNotify.delete(item.videoId);
        this.processQueue();
      });
    }
    const due = queued.filter(i => (i.retryAt ?? 0) > Date.now()).map(i => i.retryAt!);
    if (due.length) this.timer = setTimeout(() => this.processQueue(), Math.max(50, Math.min(...due) - Date.now()));
  }
  private async run(item: DownloadItem, worker: Worker): Promise<void> {
    const id = item.videoId;
    const stopped = () => worker.stopped || this.items.get(id) !== item;
    try {
      await this.changed();
      const grant = await this.io.authorize(id, item.automaticBroadcast === true);
      if (stopped()) return;
      if (grant.videoId !== id || (grant.sha256 !== null && !/^[a-f0-9]{64}$/i.test(grant.sha256)) ||
          !Number.isSafeInteger(grant.sizeBytes) || grant.sizeBytes <= 0 ||
          !validOfflineAccess(grant, item.automaticBroadcast === true)) {
        throw Object.assign(new Error("Invalid offline authorization"), { permanent: true });
      }
      if ((grant.sha256 && item.sha256 && item.sha256 !== grant.sha256) ||
          (item.totalBytes && item.totalBytes !== grant.sizeBytes)) {
        item.resumeData = undefined;
        await this.io.remove(this.path(id, ".part"));
      }
      // Renew a verified existing copy (or recover a crash after promotion)
      // without transferring the whole movie again.
      const knownHash = grant.sha256 ?? item.sha256;
      const existing = await this.io.info(this.path(id));
      if (knownHash && existing.exists && existing.size === grant.sizeBytes &&
          (await this.io.hash(this.path(id), stopped)).toLowerCase() === knownHash.toLowerCase()) {
        if (stopped()) return;
        Object.assign(item, { videoTitle: grant.videoTitle, duration: grant.duration,
          category: grant.category, preacher: grant.preacher, sourceUrl: grant.sourceUrl,
          sha256: knownHash.toLowerCase(), expiresAt: grant.expiresAt ?? undefined,
          offlinePolicy: grant.policy, checkedAt: Date.now(),
          localPath: this.path(id), status: "completed", progress: 1,
          totalBytes: grant.sizeBytes, downloadedBytes: grant.sizeBytes, error: null, resumeData: undefined });
        await this.changed(); return;
      }
      const partial = await this.io.info(this.path(id, ".part"));
      // Without a native resume checkpoint the partial will be restarted.
      // Do not subtract its bytes from the required capacity in that case.
      const requiredFree = Math.max(0, grant.sizeBytes - (item.resumeData ? partial.size : 0)) +
        (item.automaticBroadcast ? 256 * 1024 * 1024 : RESERVE);
      if (item.automaticBroadcast && await this.io.freeBytes() < requiredFree) {
        await this.reclaimOutdatedBroadcasts(requiredFree);
      }
      if (await this.io.freeBytes() < requiredFree) {
        throw Object.assign(new Error("Not enough storage. Free space and tap Retry."), { permanent: true });
      }
      if (stopped()) return;
      Object.assign(item, { videoTitle: grant.videoTitle, thumbnailUrl: grant.thumbnailUrl,
        duration: grant.duration, category: grant.category, preacher: grant.preacher,
        sourceUrl: grant.sourceUrl, sha256: grant.sha256 ?? undefined,
        expiresAt: grant.expiresAt ?? undefined, offlinePolicy: grant.policy,
        totalBytes: grant.sizeBytes, checkedAt: Date.now(), error: null });
      await this.changed();
      if (stopped()) return;
      if (!item.resumeData) await this.io.remove(this.path(id, ".part"));
      if (stopped()) return;
      worker.task = this.io.task(grant.sourceUrl, this.path(id, ".part"), item.resumeData, written => {
        if (stopped() || item.status !== "downloading") return;
        item.downloadedBytes = written; item.progress = Math.min(0.99, written / grant.sizeBytes);
        const now = Date.now();
        if (now - (this.lastNotify.get(id) ?? 0) >= 250) { this.lastNotify.set(id, now); this.notify(); }
      });
      const result = await worker.task.run();
      if (stopped()) return;
      item.resumeData = undefined;
      if (!result || ![200, 206].includes(result.status)) {
        throw Object.assign(new Error(`Download HTTP ${result?.status ?? "failed"}`),
          { permanent: !!result && [400, 401, 403, 404, 410].includes(result.status) });
      }
      item.status = "verifying"; await this.changed();
      const info = await this.io.info(this.path(id, ".part"));
      const actualHash = info.exists && info.size === grant.sizeBytes
        ? await this.io.hash(this.path(id, ".part"), stopped) : null;
      if (!actualHash || (grant.sha256 && actualHash.toLowerCase() !== grant.sha256.toLowerCase())) {
        await this.io.remove(this.path(id, ".part"));
        throw new Error("Recording integrity check failed; retry the download.");
      }
      if (stopped()) return;
      item.sha256 = actualHash.toLowerCase();
      await this.changed();
      if (stopped()) return;
      // App-controlled temporary file is promoted only after size AND SHA-256.
      await this.io.remove(this.path(id));
      await this.io.move(this.path(id, ".part"), this.path(id));
      if (stopped()) return;
      if (grant.thumbnailUrl) {
        try {
          if (await this.io.thumbnail(grant.thumbnailUrl, this.path(id, ".jpg"))) item.localThumbnail = this.path(id, ".jpg");
        } catch { /* Artwork failure must not invalidate a verified recording. */ }
      }
      if (stopped()) return;
      item.localPath = this.path(id); item.status = "completed"; item.progress = 1;
      item.downloadedBytes = grant.sizeBytes; item.completedAt = new Date().toISOString();
      await this.changed();
    } catch (error) {
      if (stopped()) return;
      const permanent = !!(error as { permanent?: boolean }).permanent ||
        /ENOSPC|storage|disk full/i.test(String((error as Error).message));
      item.retryCount++;
      item.error = error instanceof Error ? error.message : "Recording download failed";
      item.localPath = null;
      item.status = permanent || item.retryCount > 5 ? "failed" : "queued";
      item.retryAt = Date.now() + Math.min(30_000, 2000 * 2 ** (item.retryCount - 1));
      // No opaque resume blob from a failed request: safely restart unless a
      // successful explicit pause produced resumeData.
      item.resumeData = undefined;
      await this.changed();
    }
  }
  async validateForPlayback(id: string): Promise<DownloadItem> {
    await this.init();
    const item = this.items.get(id);
    if (!item || !usableOfflineGrant(item)) throw new Error("This recording is unavailable offline. Connect to renew or download it.");
    const info = await this.io.info(this.path(id));
    if (!info.exists || info.size !== item.totalBytes ||
        (await this.io.hash(this.path(id), () => this.items.get(id) !== item)).toLowerCase() !== item.sha256?.toLowerCase()) {
      item.status = "failed"; item.localPath = null; item.error = "Offline file is missing or corrupted. Download it again.";
      await this.changed(); throw new Error(item.error);
    }
    return { ...item };
  }
  savePosition(id: string, positionSecs: number): void {
    const item = this.items.get(id);
    if (!item || !Number.isFinite(positionSecs) || positionSecs < 0) return;
    item.positionSecs = positionSecs;
    void this.persist().catch(() => { item.error = "Playback position could not be saved"; this.notify(); });
  }
  async refreshAccess(): Promise<void> {
    if (this.syncing || !this.online || !this.foreground) return;
    this.syncing = true;
    try {
      for (const item of this.items.values()) {
        if (!this.online || !this.foreground) break;
        if (item.status !== "completed" || Date.now() - (item.checkedAt ?? 0) < 60 * 60 * 1000) continue;
        try {
          // Broadcast copies are durable public recordings, not expiring VOD
          // grants. No backend response can interrupt an offline session.
          if (item.offlinePolicy === "public-broadcast-recording") continue;
          const grant = await this.io.authorize(item.videoId, item.automaticBroadcast === true);
          if (this.items.get(item.videoId) !== item) continue;
          if ((grant.sha256 && grant.sha256.toLowerCase() !== item.sha256) || grant.sizeBytes !== item.totalBytes) {
            throw Object.assign(new Error("Recording was replaced. Download the current version."), { permanent: true });
          }
          item.expiresAt = grant.expiresAt ?? undefined; item.offlinePolicy = grant.policy; item.checkedAt = Date.now();
        } catch (error) {
          if ((error as { permanent?: boolean }).permanent) {
            item.status = "failed"; item.localPath = null;
            item.error = "Offline access ended or the recording changed. Connect and tap Retry.";
          }
          // Temporary backend errors never discard a still-valid local recording.
        }
      }
      await this.changed();
    } finally { this.syncing = false; }
  }
}
