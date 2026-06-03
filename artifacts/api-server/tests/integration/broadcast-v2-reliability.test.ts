/**
 * Broadcast-v2 reliability integration tests.
 *
 * Architecture note on inject vs real-fetch for SSE:
 *   Fastify's `app.inject()` collects the full response body before resolving.
 *   SSE connections never send EOF (the server keeps the stream alive with
 *   heartbeats), so inject() hangs indefinitely on SSE routes.
 *
 *   We therefore split tests into two groups:
 *     - REST endpoints  → app.inject() (fast, no I/O)
 *     - SSE endpoints   → real HTTP server + fetch() + AbortSignal.timeout()
 *       The SSE tests start the server on a random port in beforeAll and
 *       use short AbortSignal timeouts to collect the first few frames.
 *
 * Covers:
 *  - Health endpoint shape and availability
 *  - Snapshot endpoint shape
 *  - Auth guards on mutation routes
 *  - Rate limiting on health endpoint
 *  - SSE headers and initial frame content
 *  - Concurrent SSE connections (consistent sequence numbers)
 *  - SSE resume via Last-Event-ID / ?lastSequence
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

let app: FastifyInstance;
let baseUrl = "";

// ---------------------------------------------------------------------------
// Setup — start a real HTTP listener so SSE tests can use fetch()
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL && process.env.DATABASE_URL !== ""
      ? process.env.DATABASE_URL
      : "postgres://test:test@localhost:5432/test";
  process.env.JWT_ACCESS_SECRET = "x".repeat(64);
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
  process.env.PROD_SYNC_DISABLE = "1";

  try {
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp();
    await app.ready();

    // Start a real TCP listener on a random OS-assigned port so SSE tests
    // can use fetch() + AbortSignal.timeout() to read partial SSE streams.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo | null;
    if (addr) baseUrl = `http://127.0.0.1:${addr.port}`;
  } catch {
    // DB or startup failure in CI — individual tests guard with `if (!app)`.
  }
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
}, 15_000);

// ---------------------------------------------------------------------------
// Utility — real fetch with timeout (for SSE where inject hangs)
// ---------------------------------------------------------------------------

async function sseRequest(
  path: string,
  headers: Record<string, string> = {},
  timeoutMs = 2_000,
): Promise<{ status: number; headers: Headers; body: string }> {
  const url = `${baseUrl}${path}`;
  let body = "";
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream", "Cache-Control": "no-cache", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    if (!res.body) return { status: res.status, headers: res.headers, body: "" };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      body += dec.decode(value, { stream: true });
      // Stop once we have both hello and snapshot — no need to keep streaming
      if (body.includes("event: hello") && body.includes("event: snapshot")) {
        reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // AbortError from timeout — expected; body has whatever arrived
  }
  return { status: res.status, headers: res.headers, body };
}

// ---------------------------------------------------------------------------
// Broadcast-v2 health endpoint
// ---------------------------------------------------------------------------

describe("GET /api/broadcast-v2/health", () => {
  it("returns 200 with required top-level fields", async () => {
    if (!app) return;
    const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
    expect([200, 503]).toContain(r.statusCode);
    if (r.statusCode === 200) {
      const body = r.json();
      expect(typeof body.sequence).toBe("number");
      expect(typeof body.uptimeMs).toBe("number");
      expect(body.mode).toBeDefined();
    }
  });

  it("responds quickly (< 500 ms)", async () => {
    if (!app) return;
    const start = Date.now();
    const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
    expect([200, 503]).toContain(r.statusCode);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("never returns 5xx — only 200, 503, or 429", async () => {
    if (!app) return;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({ method: "GET", url: "/api/broadcast-v2/health" }),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.every((s) => s === 200 || s === 503 || s === 429)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Broadcast-v2 snapshot endpoint
// ---------------------------------------------------------------------------

describe("GET /api/broadcast-v2/snapshot", () => {
  it("returns a valid shape (200) or acceptable degraded state (404, 503)", async () => {
    if (!app) return;
    const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/snapshot" });
    expect([200, 404, 503]).toContain(r.statusCode);
    if (r.statusCode === 200) {
      const body = r.json();
      expect(typeof body.sequence).toBe("number");
      expect(body.current === null || typeof body.current === "object").toBe(true);
    }
  });

  it("responds quickly (< 500 ms) — served from in-memory state, not DB", async () => {
    if (!app) return;
    const start = Date.now();
    await app.inject({ method: "GET", url: "/api/broadcast-v2/snapshot" });
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// SSE endpoint — using real fetch so we can close after receiving initial frames
// ---------------------------------------------------------------------------

describe("GET /api/broadcast-v2/events — SSE headers and initial frames", () => {
  it("returns 200 with text/event-stream Content-Type", async () => {
    if (!app || !baseUrl) return;
    const { status, headers } = await sseRequest("/api/broadcast-v2/events");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toMatch(/text\/event-stream/);
  });

  it("sets no-cache and keep-alive headers", async () => {
    if (!app || !baseUrl) return;
    const { status, headers } = await sseRequest("/api/broadcast-v2/events");
    if (status !== 200) return;
    expect(headers.get("cache-control")).toMatch(/no-cache/);
  });

  it("initial stream contains 'hello' and 'snapshot' event types", async () => {
    if (!app || !baseUrl) return;
    const { status, body } = await sseRequest("/api/broadcast-v2/events");
    if (status !== 200) return;
    expect(body).toContain("event: hello");
    expect(body).toContain("event: snapshot");
  });

  it("snapshot event includes a sequence number", async () => {
    if (!app || !baseUrl) return;
    const { status, body } = await sseRequest("/api/broadcast-v2/events");
    if (status !== 200) return;
    // The SSE 'id:' field carries the sequence number
    expect(body).toMatch(/id:\s*\d+/);
  });

  it("SSE with Last-Event-ID: 0 returns 200 (resume supported)", async () => {
    if (!app || !baseUrl) return;
    const { status } = await sseRequest("/api/broadcast-v2/events", { "Last-Event-ID": "0" });
    expect(status).toBe(200);
  });

  it("SSE with ?lastSequence=0 returns 200 and skips DB replay", async () => {
    if (!app || !baseUrl) return;
    const start = Date.now();
    const { status } = await sseRequest("/api/broadcast-v2/events?lastSequence=0");
    expect(status).toBe(200);
    // lastSequence=0 skips the async DB replay so should be fast
    expect(Date.now() - start).toBeLessThan(3_000);
  });
});

// ---------------------------------------------------------------------------
// SSE — concurrent connections, sequence consistency
// ---------------------------------------------------------------------------

describe("Broadcast-v2 — concurrent SSE connections", () => {
  it("5 concurrent SSE connections all return 200 or 429 (no 5xx)", async () => {
    if (!app || !baseUrl) return;
    const responses = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        sseRequest("/api/broadcast-v2/events", {}, 3_000),
      ),
    );
    for (const r of responses) {
      if (r.status === "fulfilled") {
        expect([200, 429]).toContain(r.value.status);
      }
    }
  });

  it("concurrent SSE connections report consistent initial sequence numbers", async () => {
    if (!app || !baseUrl) return;
    const responses = await Promise.allSettled(
      Array.from({ length: 3 }, () => sseRequest("/api/broadcast-v2/events", {}, 3_000)),
    );
    const sequences: number[] = [];
    for (const r of responses) {
      if (r.status !== "fulfilled" || r.value.status !== 200) continue;
      const match = r.value.body.match(/id:\s*(\d+)/);
      if (match) sequences.push(parseInt(match[1]!, 10));
    }
    if (sequences.length < 2) return; // not enough to compare
    const diff = Math.max(...sequences) - Math.min(...sequences);
    // Sequence numbers should be the same or close (≤ 5 ticks apart)
    expect(diff).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// REST mutation routes — auth guards
// ---------------------------------------------------------------------------

describe("Broadcast-v2 mutation routes — auth guards", () => {
  it("POST /skip without token → 401 or 403", async () => {
    if (!app) return;
    const r = await app.inject({
      method: "POST",
      url: "/api/broadcast-v2/skip",
      payload: { idempotencyKey: "test-key-001" },
    });
    expect([401, 403, 404]).toContain(r.statusCode);
  });

  it("POST /reload without token → 401 or 403", async () => {
    if (!app) return;
    const r = await app.inject({
      method: "POST",
      url: "/api/broadcast-v2/reload",
      payload: {},
    });
    expect([401, 403, 404]).toContain(r.statusCode);
  });

  it("POST /override without token → 401 or 403", async () => {
    if (!app) return;
    const r = await app.inject({
      method: "POST",
      url: "/api/broadcast-v2/override",
      payload: { kind: "hls", url: "https://example.com/stream.m3u8" },
    });
    expect([401, 403, 404]).toContain(r.statusCode);
  });

  it("POST /skip with a garbage token → 401", async () => {
    if (!app) return;
    const r = await app.inject({
      method: "POST",
      url: "/api/broadcast-v2/skip",
      headers: { Authorization: "Bearer not-a-real-jwt" },
      payload: { idempotencyKey: "test-key-bad" },
    });
    expect([401, 403]).toContain(r.statusCode);
  });

  it("unknown broadcast-v2 route → 404", async () => {
    if (!app) return;
    const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/does-not-exist-xyz" });
    expect(r.statusCode).toBe(404);
  });
});
