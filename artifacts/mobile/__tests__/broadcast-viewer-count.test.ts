import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("mobile broadcast viewer count delivery", async () => {
  const { BroadcastEngine } = await import("../vendor/broadcast-sync/src/engine/BroadcastEngine.js");
  const makeEngine = () => {
    const engine = new BroadcastEngine({ wsUrl: "", stateUrl: "" });
    const transport = engine as unknown as {
      sync: { handleFrame(frame: unknown): void };
    };
    return { engine, frame: (frame: unknown) => transport.sync.handleFrame(frame) };
  };
  const snapshot = (viewerCount?: number) => ({
    type: "state",
    reason: "snapshot",
    state: {
      serverTimeMs: Date.now(),
      current: null, next: null, nextNext: null,
      liveOverride: null, source: "empty",
      ...(viewerCount === undefined ? {} : { viewerCount }),
    },
  });

  it("seeds the UI from the initial snapshot", () => {
    const { engine, frame } = makeEngine();
    frame(snapshot(7));
    assert.equal(engine.getState().viewerCount, 7);
    engine.stop();
  });

  it("delivers live increases and departures without changing playback time", () => {
    const { engine, frame } = makeEngine();
    frame(snapshot(1));
    const time = engine.getState().serverTimeMs;
    const received: Array<number | null> = [];
    const unsubscribe = engine.subscribe((state) => received.push(state.viewerCount));
    frame({ type: "viewer-count", count: 12 });
    frame({ type: "viewer-count", count: 0 });
    assert.deepEqual(received, [1, 12, 0]);
    assert.equal(engine.getState().serverTimeMs, time);
    unsubscribe();
    engine.stop();
  });

  it("keeps unknown distinct from zero for older servers", () => {
    const { engine, frame } = makeEngine();
    frame(snapshot());
    assert.equal(engine.getState().viewerCount, null);
    frame({ type: "viewer-count", count: 0 });
    assert.equal(engine.getState().viewerCount, 0);
    engine.stop();
  });

  it("rejects malformed counts and ignores frames after cleanup", () => {
    const { engine, frame } = makeEngine();
    frame({ type: "viewer-count", count: 3 });
    for (const count of [-1, 0.5, NaN, Infinity, "4", null]) {
      frame({ type: "viewer-count", count });
    }
    assert.equal(engine.getState().viewerCount, 3);
    engine.stop();
    frame({ type: "viewer-count", count: 4 });
    assert.equal(engine.getState().viewerCount, 3);
  });
});
