import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DownloadItem, OfflineIO, OfflineGrant } from "../services/offlineTypes";

const bytes = Buffer.from("verified-first-party-recording");
const digest = createHash("sha256").update(bytes).digest("hex");
const video = (id = "recording-1") => ({ videoId: id, videoTitle: "Recording", thumbnailUrl: "",
  duration: "12:34", category: "sermon", preacher: "JCTM", sourceUrl: "/ignored-client-url" });
const tick = () => new Promise<void>(r => setTimeout(r, 2));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.fail("Lifecycle did not settle");
}

function fixture(saved: DownloadItem[] = []) {
  const files = new Map<string, Buffer>();
  let stored = structuredClone(saved);
  let grants = 0, transfers = 0, maxTransfers = 0, running = 0;
  let free = 1024 ** 3;
  let corrupt = false;
  let denied = false;
  let hasServerHash = true;
  let block = false;
  const releases = new Map<string, () => void>();
  const io: OfflineIO = {
    directory: "file:///private/",
    async load() { return structuredClone(stored); },
    async save(items) { stored = structuredClone(items); },
    async prepare() {}, async list() { return [...files.keys()].map(k => k.split("/").at(-1)!); },
    async info(path) { return { exists: files.has(path), size: files.get(path)?.length ?? 0 }; },
    async freeBytes() { return free; },
    async remove(path) { files.delete(path); },
    async move(from, to) { files.set(to, files.get(from)!); files.delete(from); },
    async hash(path, stopped) {
      if (stopped()) throw new Error("cancelled");
      return createHash("sha256").update(files.get(path) ?? Buffer.alloc(0)).digest("hex");
    },
    async authorize(id, broadcast = false): Promise<OfflineGrant> {
      grants++;
      if (denied) throw Object.assign(new Error("revoked"), { permanent: true });
      return { ...video(id), sizeBytes: bytes.length, sha256: hasServerHash ? digest : null,
        expiresAt: broadcast ? null : new Date(Date.now() + 7 * 86400_000).toISOString(),
        policy: broadcast ? "public-broadcast-recording" : "public-recording-7-days" };
    },
    async thumbnail() { return false; },
    task(_url, path, _resume, progress) {
      let finish: () => void = () => {};
      let cancelled = false;
      return {
        async run() {
          transfers++; running++; maxTransfers = Math.max(maxTransfers, running);
          files.set(path, bytes.subarray(0, 5)); progress(5);
          if (block) await new Promise<void>(resolve => { finish = resolve; releases.set(path, resolve); });
          running--;
          if (cancelled) return undefined;
          files.set(path, corrupt ? Buffer.alloc(bytes.length) : bytes); progress(bytes.length);
          return { status: 200, uri: path };
        },
        async pause() { cancelled = true; finish(); return "native-resume-checkpoint"; },
        async cancel() { cancelled = true; finish(); },
      };
    },
  };
  return { io, files, saved: () => stored, grants: () => grants, transfers: () => transfers,
    peak: () => maxTransfers, setFree: (n: number) => { free = n; },
    corrupt: () => { corrupt = true; }, deny: () => { denied = true; }, legacy: () => { hasServerHash = false; },
    block: () => { block = true; }, release: () => { block = false; for (const done of releases.values()) done(); } };
}

describe("offline recording lifecycle", async () => {
  const { OfflineDownloadEngine } = await import("../services/offlineDownloadEngine.js");
  it("queues offline without network and suppresses duplicate IDs", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.addDownload(video());
    assert.equal(engine.getAll().length, 1);
    assert.equal(f.grants(), 0); assert.equal(f.transfers(), 0);
    await engine.clearAll();
  });
  it("verifies bytes before promotion and plays locally with the backend unreachable", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    assert.equal(f.files.has("file:///private/recording-1.part"), false);
    assert.equal(f.files.has("file:///private/recording-1.mp4"), true);
    const requests = f.grants();
    f.deny(); await engine.setConnectivity(false);
    assert.equal((await engine.validateForPlayback("recording-1")).sha256, digest);
    assert.equal(f.grants(), requests, "Local playback must never call authorize");
    engine.savePosition("recording-1", 42); await tick();
    const reopened = new OfflineDownloadEngine(f.io);
    await reopened.init();
    assert.equal((await reopened.validateForPlayback("recording-1")).positionSecs, 42);
    assert.equal(f.grants(), requests);
  });
  it("rejects a same-size corrupt transfer and never exposes it as completed", async () => {
    const f = fixture(); f.corrupt(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.getItem("recording-1")?.retryCount === 1);
    await engine.setConnectivity(false);
    assert.equal(engine.isDownloaded("recording-1"), false);
    assert.equal(f.files.has("file:///private/recording-1.mp4"), false);
    assert.equal(f.files.has("file:///private/recording-1.part"), false);
    await engine.clearAll();
  });
  it("supports legacy recordings with trusted length and a persisted local SHA-256", async () => {
    const f = fixture(); f.legacy(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    assert.equal(engine.getItem("recording-1")?.sha256, digest);
    f.deny(); await engine.setConnectivity(false);
    assert.equal((await engine.validateForPlayback("recording-1")).sha256, digest);
  });
  it("restores an interrupted transfer without networking until connectivity returns", async () => {
    const f = fixture(); f.block(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => f.transfers() === 1);
    const crashState = f.saved();
    await engine.setConnectivity(false);
    const restarted = fixture(crashState);
    restarted.files.set("file:///private/recording-1.part", bytes.subarray(0, 5));
    const reopened = new OfflineDownloadEngine(restarted.io); await reopened.init();
    assert.equal(reopened.getItem("recording-1")?.status, "paused");
    assert.equal(restarted.transfers(), 0);
    await reopened.setConnectivity(true);
    await until(() => reopened.isDownloaded("recording-1"));
    assert.equal(restarted.transfers(), 1);
  });
  it("detects post-download corruption before playback", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    f.files.set("file:///private/recording-1.mp4", Buffer.alloc(bytes.length));
    await assert.rejects(engine.validateForPlayback("recording-1"), /corrupted/);
    assert.equal(engine.getItem("recording-1")?.status, "failed");
  });
  it("refuses insufficient storage without opening a transfer", async () => {
    const f = fixture(); f.setFree(1); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.getItem("recording-1")?.status === "failed");
    assert.match(engine.getItem("recording-1")!.error!, /storage/);
    assert.equal(f.transfers(), 0);
  });
  it("caps simultaneous native transfers at two and cancels without resurrection", async () => {
    const f = fixture(); f.block(); const engine = new OfflineDownloadEngine(f.io);
    for (let i = 0; i < 6; i++) await engine.addDownload(video(`recording-${i}`));
    await engine.setConnectivity(true); await until(() => f.transfers() === 2);
    assert.equal(f.peak(), 2);
    await engine.cancelDownload("recording-0");
    await until(() => f.transfers() === 3);
    assert.equal(engine.getItem("recording-0"), undefined);
    assert.equal(f.files.has("file:///private/recording-0.part"), false);
    await engine.setConnectivity(false); await engine.clearAll();
    assert.equal(engine.getAll().length, 0);
    assert.equal(f.files.size, 0);
  });
  it("parks on disconnection, persists resume data, then recovers once", async () => {
    const f = fixture(); f.block(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => f.transfers() === 1);
    await engine.setConnectivity(false);
    assert.equal(engine.getItem("recording-1")?.status, "paused");
    assert.equal(f.saved()[0]?.resumeData, "native-resume-checkpoint");
    f.release(); await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    assert.equal(f.transfers(), 2); assert.equal(f.peak(), 1);
  });
  it("does not auto-resume a user-paused download on reconnection", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.pauseDownload("recording-1");
    await engine.setConnectivity(true);
    assert.equal(f.transfers(), 0);
    await engine.resumeDownload("recording-1");
    await until(() => engine.isDownloaded("recording-1"));
  });
  it("parks while backgrounded and recovers in the foreground", async () => {
    const f = fixture(); f.block(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => f.transfers() === 1);
    await engine.setConnectivity(true, false);
    assert.equal(engine.getItem("recording-1")?.status, "paused");
    f.release(); await engine.setConnectivity(true, true);
    await until(() => engine.isDownloaded("recording-1"));
  });
  it("rejects unapproved recordings without starting a download", async () => {
    const f = fixture(); f.deny(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.getItem("recording-1")?.status === "failed");
    assert.equal(f.transfers(), 0);
  });
  it("does not play an expired grant or make a request while offline", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    const saved = f.saved(); saved[0]!.expiresAt = new Date(0).toISOString();
    const restored = fixture(saved); restored.files.set("file:///private/recording-1.mp4", bytes);
    const reopened = new OfflineDownloadEngine(restored.io);
    await assert.rejects(reopened.validateForPlayback("recording-1"), /unavailable offline/);
    assert.equal(restored.grants(), 0);
  });
  it("cleans abandoned temporary files without deleting unknown completed recordings", async () => {
    const f = fixture();
    f.files.set("file:///private/abandoned.part", bytes);
    f.files.set("file:///private/old.jpg.part", bytes);
    f.files.set("file:///private/orphan.mp4", bytes);
    const engine = new OfflineDownloadEngine(f.io); await engine.init();
    assert.equal(f.files.size, 1); assert.ok(f.files.has("file:///private/orphan.mp4"));
  });
  it("rejects path traversal", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await assert.rejects(engine.addDownload(video("../private")), /identifier/);
    assert.equal(f.grants(), 0);
  });
  it("automatically prepares durable broadcast files and plays after restart with no backend", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.prepareBroadcast(video());
    assert.equal(f.transfers(), 0);
    await engine.setAutomaticTransfersAllowed(true);
    await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    assert.equal(engine.getItem("recording-1")?.offlinePolicy, "public-broadcast-recording");
    assert.equal(engine.getItem("recording-1")?.expiresAt, undefined);
    await engine.setConnectivity(false);
    f.deny();
    const requests = f.grants();
    const reopened = new OfflineDownloadEngine(f.io);
    assert.equal((await reopened.validateForPlayback("recording-1")).localPath, "file:///private/recording-1.mp4");
    assert.equal(f.grants(), requests);
    await reopened.clearAll();
  });
  it("upgrades a complete manual copy to a broadcast copy without transferring again", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.addDownload(video()); await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    await tick();
    const transfers = f.transfers();
    await engine.setAutomaticTransfersAllowed(true);
    await engine.prepareBroadcast(video());
    await until(() => engine.getItem("recording-1")?.offlinePolicy === "public-broadcast-recording");
    assert.equal(f.transfers(), transfers);
    assert.equal(engine.getItem("recording-1")?.retainManualCopy, true);
    await engine.clearAll();
  });
  it("bounds automatic preparation to one transfer while preserving all queued recordings", async () => {
    const f = fixture(); f.block();
    const engine = new OfflineDownloadEngine(f.io);
    await engine.setAutomaticTransfersAllowed(true);
    for (let i = 0; i < 5; i++) await engine.prepareBroadcast(video(`broadcast-${i}`));
    await engine.setConnectivity(true);
    await until(() => f.transfers() === 1);
    assert.equal(f.peak(), 1);
    f.release();
    await until(() => engine.getAll().every(item => item.status === "completed"));
    assert.equal(f.transfers(), 5); assert.equal(f.peak(), 1);
    await engine.clearAll();
  });
  it("reserves device storage for automatic preparation and recovers without deleting manual content", async () => {
    const f = fixture(); f.setFree(100 * 1024 * 1024);
    const engine = new OfflineDownloadEngine(f.io);
    await engine.setAutomaticTransfersAllowed(true);
    await engine.prepareBroadcast(video()); await engine.setConnectivity(true);
    await until(() => engine.getItem("recording-1")?.status === "failed");
    assert.equal(f.transfers(), 0);
    f.setFree(1024 ** 3); await engine.prepareBroadcast(video());
    await until(() => engine.isDownloaded("recording-1"));
    await engine.clearAll();
  });
  it("never revalidates a durable broadcast recording with the backend", async () => {
    const f = fixture(); const engine = new OfflineDownloadEngine(f.io);
    await engine.setAutomaticTransfersAllowed(true);
    await engine.prepareBroadcast(video()); await engine.setConnectivity(true);
    await until(() => engine.isDownloaded("recording-1"));
    const stored = f.saved(); stored[0]!.checkedAt = 0;
    const restored = fixture(stored);
    restored.files.set("file:///private/recording-1.mp4", bytes);
    restored.deny();
    const reopened = new OfflineDownloadEngine(restored.io);
    await reopened.setConnectivity(true); await reopened.refreshAccess();
    assert.equal(restored.grants(), 0);
    assert.equal((await reopened.validateForPlayback("recording-1")).videoId, "recording-1");
    await reopened.clearAll(); await engine.clearAll();
  });
  it("does not transfer automatically on cellular and parks immediately when Wi-Fi is lost", async () => {
    const f = fixture(); f.block();
    const engine = new OfflineDownloadEngine(f.io);
    await engine.prepareBroadcast(video()); await engine.setConnectivity(true);
    await tick(); assert.equal(f.transfers(), 0);
    await engine.setAutomaticTransfersAllowed(true);
    await until(() => f.transfers() === 1);
    await engine.setAutomaticTransfersAllowed(false);
    await until(() => engine.getItem("recording-1")?.status === "paused");
    assert.equal(engine.getItem("recording-1")?.autoResume, true);
    f.release(); await engine.setAutomaticTransfersAllowed(true);
    await until(() => engine.isDownloaded("recording-1"));
    await engine.clearAll();
  });
  it("reclaims only outdated automatic copies, never an active playback or manual file", async () => {
    const f = fixture([completeForStorage("old"), completeForStorage("playing"),
      { ...completeForStorage("manual"), automaticBroadcast: false }]);
    for (const id of ["old", "playing", "manual"]) f.files.set(`file:///private/${id}.mp4`, bytes);
    const engine = new OfflineDownloadEngine(f.io);
    await engine.init(); engine.setBroadcastLineup(["new"]);
    const releasePin = engine.pinForPlayback("playing");
    f.setFree(100);
    await engine.setAutomaticTransfersAllowed(true);
    await engine.prepareBroadcast(video("new")); await engine.setConnectivity(true);
    await until(() => engine.getItem("new")?.status === "failed");
    assert.equal(engine.getItem("old"), undefined);
    assert.equal(f.files.has("file:///private/playing.mp4"), true);
    assert.equal(f.files.has("file:///private/manual.mp4"), true);
    releasePin(); await engine.clearAll();
  });
});

function completeForStorage(id: string): DownloadItem {
  return { ...video(id), localPath: `file:///private/${id}.mp4`, status: "completed", progress: 1,
    totalBytes: bytes.length, downloadedBytes: bytes.length, sha256: digest,
    offlinePolicy: "public-broadcast-recording", automaticBroadcast: true,
    createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(),
    retryCount: 0, error: null };
}
