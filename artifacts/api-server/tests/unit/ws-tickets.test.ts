import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  clearChatWsTicketsForTests,
  consumeChatWsTicket,
  issueChatWsTicket,
} from "../../src/modules/realtime/ws-tickets.js";

describe("chat websocket tickets", () => {
  beforeEach(() => clearChatWsTicketsForTests());

  it("is bound to its channel and cannot be replayed", () => {
    const issued = issueChatWsTicket({ channelId: "live", userId: "u1", email: "u@example.com", role: "user" });
    assert.equal(consumeChatWsTicket(issued.ticket, "other"), null);
    assert.equal(consumeChatWsTicket(issued.ticket, "live"), null);
  });

  it("returns the bound identity once", () => {
    const issued = issueChatWsTicket({ channelId: "live", userId: "u1", email: "u@example.com", role: "moderator" });
    const consumed = consumeChatWsTicket(issued.ticket, "live");
    assert.equal(consumed?.channelId, "live");
    assert.equal(consumed?.userId, "u1");
    assert.equal(consumed?.role, "moderator");
    assert.equal(typeof consumed?.expiresAt, "number");
    assert.equal(consumeChatWsTicket(issued.ticket, "live"), null);
  });

  it("rejects expired tickets", async () => {
    const issued = issueChatWsTicket({ channelId: "live", userId: "u1", email: "u@example.com" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(consumeChatWsTicket(issued.ticket, "live"), null);
  });
});
