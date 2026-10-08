import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("live mobile viewer presence", async () => {
  const { isLiveViewerWatching } = await import("../lib/viewerPresence.js");
  const broadcast = { isLive: true, isBroadcast: true, contextPlaying: false };

  it("counts broadcast playback even when the unrelated PlayerContext flag is false", () => {
    for (const broadcastState of ["PLAYING", "PREPARING_NEXT", "HANDOFF", "LIVE_OVERRIDE_ACTIVE"]) {
      assert.equal(isLiveViewerWatching({ ...broadcast, broadcastState }), true);
    }
  });

  it("does not register unavailable, starting, or failed broadcast players", () => {
    for (const broadcastState of ["BOOTSTRAP", "SYNCING", "PREPARING_ACTIVE",
      "OFFLINE_HOLD", "RECOVERING_PRIMARY", "RECOVERING_FAILOVER", "FATAL"]) {
      assert.equal(isLiveViewerWatching({ ...broadcast, contextPlaying: true, broadcastState }), false);
    }
  });

  it("excludes VOD and respects play/pause on the non-broadcast live surface", () => {
    assert.equal(isLiveViewerWatching({ ...broadcast, isLive: false, broadcastState: "PLAYING" }), false);
    assert.equal(isLiveViewerWatching({ ...broadcast, isBroadcast: false, broadcastState: "PLAYING" }), false);
    assert.equal(isLiveViewerWatching({
      ...broadcast, isBroadcast: false, contextPlaying: true, broadcastState: "BOOTSTRAP",
    }), true);
  });
});
