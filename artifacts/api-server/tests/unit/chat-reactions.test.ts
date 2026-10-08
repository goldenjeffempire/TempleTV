import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChatHub } from "../../src/modules/realtime/chat.hub.js";

describe("ChatHub reaction bounds and cleanup", () => {
  it("removes reaction state when a message is deleted", () => {
    const hub = new ChatHub();
    hub.toggleReaction("live", "message-1", "❤️", "user-1");
    assert.deepEqual(hub.getReactions("message-1"), { "❤️": 1 });
    hub.publishDelete("live", "message-1");
    assert.deepEqual(hub.getReactions("message-1"), {});
  });

  it("bounds the number of retained reaction messages", () => {
    const hub = new ChatHub();
    for (let i = 0; i < 5_001; i += 1) {
      hub.toggleReaction("live", `message-${i}`, "❤️", `user-${i}`);
    }
    assert.deepEqual(hub.getReactions("message-0"), {});
    assert.deepEqual(hub.getReactions("message-5000"), { "❤️": 1 });
  });
});
