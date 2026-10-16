import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DownloadItem } from "../services/offlineTypes";
import type { BroadcastRecording } from "../services/offlineBroadcastEngine";

const recording = (id: string, order = 0): BroadcastRecording => ({
  videoId: id, videoTitle: id, sourceUrl: "/api/v1/uploads/video.mp4",
  thumbnailUrl: "", duration: "60", category: "sermon", preacher: "", order,
});
const complete = (id: string): DownloadItem => ({
  ...recording(id), localPath: `file:///private/${id}.mp4`, status: "completed",
  progress: 1, totalBytes: 100, downloadedBytes: 100,
  createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(),
  retryCount: 0, error: null, automaticBroadcast: true,
  offlinePolicy: "public-broadcast-recording", sha256: "a".repeat(64),
});

describe("automatic broadcast lineup", async () => {
  const { OfflineBroadcastEngine } = await import("../services/offlineBroadcastEngine.js");
  const { mayPrepareBroadcast, mayLoadBroadcastBuffer } = await import("../lib/broadcastDownloadPolicy.js");
  it("blocks speculative MP4 data on cellular but allows local files, active playback and handoff", () => {
    const idle = { kind: "mp4", active: false, local: false, preload: false, required: false };
    assert.equal(mayLoadBroadcastBuffer(idle), false);
    assert.equal(mayLoadBroadcastBuffer({ ...idle, local: true }), true);
    assert.equal(mayLoadBroadcastBuffer({ ...idle, active: true }), true);
    assert.equal(mayLoadBroadcastBuffer({ ...idle, required: true }), true);
    assert.equal(mayLoadBroadcastBuffer({ ...idle, preload: true }), true);
    assert.equal(mayLoadBroadcastBuffer({ ...idle, kind: "hls" }), true);
    assert.equal(mayLoadBroadcastBuffer({ ...idle, kind: "youtube" }), true);
  });
  it("allows Wi-Fi/Ethernet but blocks mobile data, unknown, VPN and offline transports by default", () => {
    const connected = { isConnected: true, isInternetReachable: true };
    for (const type of ["WIFI", "ETHERNET"]) assert.equal(mayPrepareBroadcast(true, { ...connected, type }), true);
    for (const type of ["CELLULAR", "UNKNOWN", "VPN", "NONE", "OTHER"]) {
      assert.equal(mayPrepareBroadcast(true, { ...connected, type }), false);
    }
    assert.equal(mayPrepareBroadcast(true, { ...connected, type: "CELLULAR" }, true), true);
    assert.equal(mayPrepareBroadcast(false, { ...connected, type: "WIFI" }), false);
    assert.equal(mayPrepareBroadcast(true, { ...connected, type: "WIFI", isInternetReachable: false }), false);
  });
  function fixture() {
    let stored: unknown = null;
    let pages = [{ items: [recording("a", 2), recording("b", 1)], nextCursor: null as string | null }];
    let failure = false;
    let requests = 0;
    const prepared: string[] = [];
    const items: DownloadItem[] = [];
    const io = {
      async load() { return structuredClone(stored); },
      async save(value: unknown) { stored = structuredClone(value); },
      async page(cursor?: string) {
        requests++;
        if (failure) throw new Error("Backend unavailable");
        return pages[cursor ? 1 : 0]!;
      },
      items: () => items,
      async prepare(item: BroadcastRecording) { prepared.push(item.videoId); },
    };
    return { engine: new OfflineBroadcastEngine(io), io, items, prepared,
      pages: (value: typeof pages) => { pages = value; },
      fail: () => { failure = true; }, requests: () => requests };
  }
  it("prepares every paginated recording in broadcast order without user action", async () => {
    const f = fixture();
    f.pages([{ items: [recording("a", 2)], nextCursor: "next" },
      { items: [recording("b", 1), recording("a", 2)], nextCursor: null }]);
    f.engine.setActive(true); await f.engine.sync();
    assert.deepEqual(f.prepared, ["b", "a"]);
    assert.equal(f.engine.state().total, 2);
    assert.equal(f.engine.state().ready, 0);
  });
  it("starts cold offline, loops through complete files and never queries the backend", async () => {
    const f = fixture(); f.engine.setActive(true); await f.engine.sync();
    f.items.push(complete("a"), complete("b"));
    await f.engine.remember("a");
    const reopened = new OfflineBroadcastEngine(f.io);
    f.fail(); const requests = f.requests();
    await reopened.init(); await reopened.sync();
    assert.equal(reopened.choose()?.videoId, "a");
    assert.equal(reopened.choose(undefined, "a")?.videoId, "b");
    assert.equal(reopened.choose(undefined, "b")?.videoId, "a");
    assert.equal(f.requests(), requests);
  });
  it("retains a usable saved lineup across a failed online refresh", async () => {
    const f = fixture(); f.engine.setActive(true); await f.engine.sync();
    f.items.push(complete("a")); f.fail(); await f.engine.sync();
    assert.equal(f.engine.choose()?.videoId, "a");
    assert.equal(f.engine.state().ready, 1);
    assert.match(f.engine.state().error!, /Backend unavailable/);
  });
  it("never counts partial, expired manual or unverified files as offline broadcasts", async () => {
    const f = fixture(); await f.engine.init();
    f.items.push({ ...complete("a"), status: "downloading", progress: 0.5 },
      { ...complete("b"), offlinePolicy: "public-recording-7-days", expiresAt: new Date(0).toISOString() },
      { ...complete("c"), sha256: undefined });
    assert.deepEqual(f.engine.playable(), []);
    assert.equal(f.engine.choose(), undefined);
  });
  it("preserves complete recordings removed from the online rotation", async () => {
    const f = fixture(); f.engine.setActive(true); await f.engine.sync();
    f.items.push(complete("a"));
    f.pages([{ items: [recording("new")], nextCursor: null }]);
    await f.engine.sync();
    assert.equal(f.engine.choose()?.videoId, "a");
    assert.equal(f.engine.state().total, 2);
  });
  it("coalesces concurrent synchronization attempts", async () => {
    const f = fixture(); f.engine.setActive(true);
    await Promise.all([f.engine.sync(), f.engine.sync(), f.engine.sync()]);
    assert.equal(f.requests(), 1);
    assert.deepEqual(f.prepared, ["b", "a"]);
  });
  it("rejects a looping or malformed manifest without replacing the saved lineup", async () => {
    const f = fixture(); f.engine.setActive(true); await f.engine.sync();
    f.pages([{ items: [recording("other")], nextCursor: "repeat" },
      { items: [], nextCursor: "repeat" }]);
    await f.engine.sync();
    assert.match(f.engine.state().error!, /Invalid/);
    assert.equal(f.engine.state().total, 2);
  });
  it("does not enqueue results from a request abandoned on backgrounding", async () => {
    const f = fixture();
    let release: (value: { items: BroadcastRecording[]; nextCursor: null }) => void = () => {};
    const engine = new OfflineBroadcastEngine({ ...f.io,
      page: async () => new Promise(resolve => { release = resolve; }) });
    await engine.init(); engine.setActive(true);
    const sync = engine.sync();
    await new Promise(resolve => setTimeout(resolve, 0));
    engine.setActive(false); release({ items: [recording("late")], nextCursor: null });
    await sync;
    assert.deepEqual(f.prepared, []);
    assert.equal(engine.state().total, 0);
  });
});
