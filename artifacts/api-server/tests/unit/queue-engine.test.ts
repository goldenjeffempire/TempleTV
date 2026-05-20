import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  process.env.JWT_ACCESS_SECRET = "x".repeat(64);
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
});

describe("BroadcastSnapshot shape", () => {
  it("is JSON-serializable when the queue is empty", async () => {
    const { broadcastEngine } = await import("../../src/modules/broadcast/queue.engine.js");
    const snap = broadcastEngine.snapshot();
    expect(snap.channelId).toBe("temple-tv-live");
    expect(snap.current).toBeNull();
    expect(snap.next).toBeNull();
    expect(snap.upcoming).toEqual([]);
    const json = JSON.stringify(snap);
    expect(JSON.parse(json)).toMatchObject({ channelId: "temple-tv-live" });
  });

  it("tracks viewer counts and emits events", async () => {
    const { broadcastEngine } = await import("../../src/modules/broadcast/queue.engine.js");
    let observed = -1;
    broadcastEngine.on("event", (e) => {
      if (e.type === "viewer-count") observed = e.data.count;
    });
    broadcastEngine.setViewerCount(7);
    expect(observed).toBe(7);
    expect(broadcastEngine.getViewerCount()).toBe(7);
  });
});
