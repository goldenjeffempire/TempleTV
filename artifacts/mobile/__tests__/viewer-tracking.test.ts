import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mobile viewer tracking contract", async () => {
  const tracking = await import("../lib/viewerTrackingApi.js");

  it("issues an anonymous mobile credential with the canonical stream", async () => {
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({
        sessionId: "server-session",
        streamId: "temple-tv-live",
      }), { status: 200 });
    }) as typeof fetch;

    const session = await tracking.issueViewerCredential("https://api.example");
    assert.equal(session.sessionId, "server-session");
    assert.deepEqual(JSON.parse(String(request?.body)), {
      streamId: "temple-tv-live",
      platform: "mobile",
    });
    assert.equal((request?.headers as Record<string, string>).Authorization, undefined);
  });

  it("sends auth only when issuing and uses the server session for heartbeats", async () => {
    const requests: Array<{ body: unknown; headers: HeadersInit }> = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        headers: init?.headers ?? {},
      });
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          sessionId: "server-session",
          streamId: "temple-tv-live",
        }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await tracking.issueViewerCredential("https://api.example", "access-token");
    await tracking.sendViewerHeartbeat("https://api.example", {
      sessionId: "server-session",
      streamId: "temple-tv-live",
    });
    const issueRequest = requests[0];
    const heartbeatRequest = requests[1];
    assert.ok(issueRequest);
    assert.ok(heartbeatRequest);
    assert.equal((issueRequest.headers as Record<string, string>).Authorization, "Bearer access-token");
    assert.deepEqual(heartbeatRequest.body, {
      sessionId: "server-session",
      streamId: "temple-tv-live",
      platform: "mobile",
      clientTs: (heartbeatRequest.body as { clientTs: number }).clientTs,
      sequence: (heartbeatRequest.body as { sequence: number }).sequence,
    });
    assert.ok(Number.isSafeInteger((heartbeatRequest.body as { sequence: number }).sequence));
  });

  it("resumes the same installation and orders heartbeat/leave after the server floor", async () => {
    const bodies: any[] = [];
    const floor = Date.now() * 1000 + 100_000;
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return new Response(JSON.stringify({
        sessionId: "persisted-capability", streamId: "temple-tv-live", nextSequence: floor,
      }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const session = await tracking.issueViewerCredential("https://api.example/", undefined, "persisted-capability");
    await tracking.sendViewerHeartbeat("https://api.example/", session);
    await tracking.leaveViewerSession("https://api.example/", session);
    assert.equal(bodies[0].resumeSessionId, "persisted-capability");
    assert.ok(bodies[1].sequence > floor);
    assert.ok(bodies[2].sequence > bodies[1].sequence);
  });
});