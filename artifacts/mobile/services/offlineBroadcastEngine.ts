import { isSafeVideoId, usableOfflineGrant, type DownloadItem } from "./offlineTypes";

export interface BroadcastRecording {
  videoId: string;
  videoTitle: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  sourceUrl: string;
  order: number;
}
export interface BroadcastPreparation {
  total: number;
  ready: number;
  preparing: boolean;
  error: string | null;
  waitingForWifi?: boolean;
}
interface BroadcastIO {
  load(): Promise<unknown>;
  save(value: { recordings: BroadcastRecording[]; currentId: string | null }): Promise<void>;
  page(cursor?: string, signal?: AbortSignal): Promise<{ items: BroadcastRecording[]; nextCursor: string | null }>;
  items(): DownloadItem[];
  prepare(item: BroadcastRecording): Promise<void>;
  lineup?(ids: string[]): void;
}

function validRecording(value: unknown): value is BroadcastRecording {
  if (!value || typeof value !== "object") return false;
  const item = value as BroadcastRecording;
  return isSafeVideoId(item.videoId) &&
    ["videoTitle", "thumbnailUrl", "duration", "category", "preacher", "sourceUrl"]
      .every(key => typeof item[key as keyof BroadcastRecording] === "string") &&
    Number.isSafeInteger(item.order);
}

/** Only metadata and complete recordings; no stream segments or live leases. */
export class OfflineBroadcastEngine {
  private recordings: BroadcastRecording[] = [];
  private currentId: string | null = null;
  private initialization?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private syncing?: Promise<void>;
  private controller?: AbortController;
  private active = false;
  private error: string | null = null;
  private listeners = new Set<() => void>();

  constructor(private io: BroadcastIO) {}
  init(): Promise<void> {
    return this.initialization ??= (async () => {
      const stored = await this.io.load() as { recordings?: unknown; currentId?: unknown } | null;
      if (stored && (!Array.isArray(stored.recordings) || !stored.recordings.every(validRecording))) {
        throw new Error("Automatic broadcast metadata is damaged; existing video files have been preserved.");
      }
      this.recordings = stored?.recordings as BroadcastRecording[] ?? [];
      this.io.lineup?.(this.recordings.map(item => item.videoId));
      this.currentId = typeof stored?.currentId === "string" && isSafeVideoId(stored.currentId)
        ? stored.currentId : null;
      this.notify();
    })();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private persist(): Promise<void> {
    const value = { recordings: this.recordings.map(item => ({ ...item })), currentId: this.currentId };
    return this.writes = this.writes.catch(() => {}).then(() => this.io.save(value));
  }
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.controller?.abort();
  }
  /** Coalesces foreground/poll triggers; cancelled responses never replace disk state. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    if (!this.active) return Promise.resolve();
    this.syncing = this.synchronize().catch(error => {
      if (this.active) this.error = error instanceof Error ? error.message : "Broadcast preparation failed";
    }).finally(() => { this.syncing = undefined; this.notify(); });
    this.notify();
    return this.syncing;
  }
  private async synchronize(): Promise<void> {
    await this.init();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const recordings = new Map<string, BroadcastRecording>();
      const visited = new Set<string>();
      let cursor: string | undefined;
      do {
        if (!this.active || controller.signal.aborted) return;
        const page = await this.io.page(cursor, controller.signal);
        if (controller.signal.aborted || !this.active) return;
        if (!page || !Array.isArray(page.items) || page.items.length > 100 ||
            !page.items.every(validRecording) ||
            (page.nextCursor !== null && (typeof page.nextCursor !== "string" ||
              !isSafeVideoId(page.nextCursor) || visited.has(page.nextCursor)))) {
          throw new Error("Invalid automatic broadcast manifest");
        }
        for (const item of page.items) recordings.set(item.videoId, item);
        if (recordings.size > 10_000 || visited.size > 1000) throw new Error("Broadcast lineup exceeds this device's metadata limit");
        cursor = page.nextCursor ?? undefined;
        if (cursor) visited.add(cursor);
      } while (cursor);
      this.recordings = [...recordings.values()].sort((a, b) => a.order - b.order || a.videoId.localeCompare(b.videoId));
      await this.persist();
      this.io.lineup?.(this.recordings.map(item => item.videoId));
      for (const item of this.recordings) {
        if (!this.active || controller.signal.aborted) return;
        await this.io.prepare(item);
      }
      this.error = null;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
  state(): BroadcastPreparation {
    const items = this.io.items();
    const ids = new Set(this.recordings.map(item => item.videoId));
    // Retain completed broadcast copies even after an administrator rotates
    // the online lineup. Never evict unrelated/manual downloads.
    for (const item of items) if (item.automaticBroadcast) ids.add(item.videoId);
    const ready = items.filter(item => ids.has(item.videoId) &&
      item.offlinePolicy === "public-broadcast-recording" && usableOfflineGrant(item)).length;
    return { total: ids.size, ready, preparing: !!this.syncing ||
      items.some(item => item.automaticBroadcast && ["queued", "downloading", "verifying"].includes(item.status)),
      error: this.error ?? items.find(item => item.automaticBroadcast && item.status === "failed")?.error ?? null };
  }
  playable(): DownloadItem[] {
    const items = this.io.items();
    const ids = [...this.recordings.map(item => item.videoId),
      ...items.filter(item => item.automaticBroadcast).map(item => item.videoId)];
    const byId = new Map(items.map(item => [item.videoId, item]));
    return [...new Set(ids)].flatMap(id => {
      const item = byId.get(id);
      return item?.offlinePolicy === "public-broadcast-recording" && usableOfflineGrant(item) ? [item] : [];
    });
  }
  choose(preferredId?: string, afterId?: string, excluded?: ReadonlySet<string>): DownloadItem | undefined {
    const items = this.playable().filter(item => !excluded?.has(item.videoId));
    if (afterId) return items[(items.findIndex(item => item.videoId === afterId) + 1) % items.length];
    return items.find(item => item.videoId === (preferredId ?? this.currentId)) ?? items[0];
  }
  async remember(id: string): Promise<void> {
    await this.init();
    if (!isSafeVideoId(id) || this.currentId === id) return;
    this.currentId = id;
    await this.persist();
  }
}
