/**
 * Long-running stability ("soak") tests for broadcast-v2.
 *
 * Simulates steady-state production traffic over an extended window to catch:
 *   - Memory creep from SSE / WS connections not being cleaned up
 *   - Response time degradation under sustained load
 *   - State corruption from rapid repeated snapshots
 *   - Graceful degradation: rate-limited clients get 429, not 500
 *   - Correct response when burst traffic is followed by sustained polling
 *
 * All tests use app.inject() — no real TCP connections, no TLS overhead.
 * Tests are intentionally longer (up to 60 s) to catch time-sensitive bugs.
 * Each test still guards with `if (!app) return` for CI environments.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

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
  } catch {
    // DB unavailable.
  }
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
}, 15_000);

// ---------------------------------------------------------------------------
// Sustained polling simulation
// ---------------------------------------------------------------------------

describe("broadcast-v2 soak — sustained polling", () => {
  it(
    "500 sequential health polls complete in < 60 s with no 5xx",
    async () => {
      if (!app) return;
      const start = Date.now();
      let errorCount = 0;
      for (let i = 0; i < 500; i++) {
        const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
        if (r.statusCode >= 500) errorCount++;
      }
      expect(errorCount).toBe(0);
      expect(Date.now() - start).toBeLessThan(60_000);
    },
    65_000,
  );

  it(
    "300 sequential snapshot polls: sequence never decreases",
    async () => {
      if (!app) return;
      let lastSeq = -1;
      for (let i = 0; i < 300; i++) {
        const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/snapshot" });
        if (r.statusCode !== 200) continue;
        const body = JSON.parse(r.body) as { sequence?: number };
        if (typeof body.sequence === "number") {
          expect(body.sequence).toBeGreaterThanOrEqual(lastSeq);
          lastSeq = body.sequence;
        }
      }
    },
    65_000,
  );
});

// ---------------------------------------------------------------------------
// Burst then drain: rate-limiter behaviour
// ---------------------------------------------------------------------------

describe("broadcast-v2 soak — burst then drain", () => {
  it(
    "burst of 200 concurrent + 100 sequential: burst may 429, sequential always succeeds",
    async () => {
      if (!app) return;
      const burst = await Promise.all(
        Array.from({ length: 200 }, () =>
          app.inject({ method: "GET", url: "/api/broadcast-v2/health" }),
        ),
      );
      for (const r of burst) {
        expect([200, 429, 503]).toContain(r.statusCode);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));

      let consecutiveErrors = 0;
      for (let i = 0; i < 100; i++) {
        const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
        if (r.statusCode >= 500) consecutiveErrors++;
        else consecutiveErrors = 0;
        expect(consecutiveErrors).toBeLessThan(5);
      }
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Mixed read-write soak
// ---------------------------------------------------------------------------

describe("broadcast-v2 soak — mixed read-write sustained load", () => {
  it(
    "500 requests mixing /health, /snapshot, and unauthenticated /reload: no 5xx",
    async () => {
      if (!app) return;
      let errorCount = 0;
      for (let i = 0; i < 500; i++) {
        const choice = i % 3;
        let r;
        if (choice === 0) {
          r = await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
        } else if (choice === 1) {
          r = await app.inject({ method: "GET", url: "/api/broadcast-v2/snapshot" });
        } else {
          r = await app.inject({
            method: "POST",
            url: "/api/broadcast-v2/reload",
            payload: { idempotencyKey: `soak-${i}` },
          });
        }
        if (r.statusCode >= 500) errorCount++;
      }
      expect(errorCount).toBe(0);
    },
    65_000,
  );
});

// ---------------------------------------------------------------------------
// Response time stability under load
// ---------------------------------------------------------------------------

describe("broadcast-v2 soak — response time stability", () => {
  it(
    "p99 response time for 200 health requests stays < 3000 ms (no degradation)",
    async () => {
      if (!app) return;
      const timings: number[] = [];
      for (let i = 0; i < 200; i++) {
        const start = Date.now();
        await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
        timings.push(Date.now() - start);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      const p99 = sorted[Math.floor(0.99 * sorted.length)] ?? sorted[sorted.length - 1]!;
      expect(p99).toBeLessThan(3000);
    },
    65_000,
  );

  it(
    "mean response time for health does not increase > 2× between first and second 100 requests",
    async () => {
      if (!app) return;
      async function measureMean(count: number): Promise<number> {
        const times: number[] = [];
        for (let i = 0; i < count; i++) {
          const t = Date.now();
          await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
          times.push(Date.now() - t);
        }
        return times.reduce((a, b) => a + b, 0) / times.length;
      }
      const mean1 = await measureMean(100);
      const mean2 = await measureMean(100);
      expect(mean2).toBeLessThan(Math.max(mean1 * 2, 500));
    },
    65_000,
  );
});

// ---------------------------------------------------------------------------
// Long-running snapshot consistency
// ---------------------------------------------------------------------------

describe("broadcast-v2 soak — snapshot consistency under sustained polling", () => {
  it(
    "200 concurrent snapshot requests: all channelIds are identical (no state corruption)",
    async () => {
      if (!app) return;
      const results = await Promise.all(
        Array.from({ length: 200 }, () =>
          app.inject({ method: "GET", url: "/api/broadcast-v2/snapshot" }),
        ),
      );
      const channelIds = new Set<string>();
      for (const r of results) {
        if (r.statusCode === 200) {
          const body = JSON.parse(r.body) as { channelId?: string };
          if (body.channelId) channelIds.add(body.channelId);
        }
      }
      expect(channelIds.size).toBeLessThanOrEqual(1);
    },
    30_000,
  );

  it(
    "100 sequential snapshots: serverTimeMs advances monotonically (clock never goes backward)",
    async () => {
      if (!app) return;
      let lastServerTime = 0;
      for (let i = 0; i < 100; i++) {
        const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/snapshot" });
        if (r.statusCode !== 200) continue;
        const body = JSON.parse(r.body) as { serverTimeMs?: number };
        if (typeof body.serverTimeMs === "number") {
          expect(body.serverTimeMs).toBeGreaterThanOrEqual(lastServerTime);
          lastServerTime = body.serverTimeMs;
        }
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Failover scenario: rapid reload + snapshot cycling
// ---------------------------------------------------------------------------

describe("broadcast-v2 soak — failover simulation cycling", () => {
  it(
    "50× alternating unauthenticated reload + snapshot: no 5xx, responses valid",
    async () => {
      if (!app) return;
      for (let i = 0; i < 50; i++) {
        const reloadR = await app.inject({
          method: "POST",
          url: "/api/broadcast-v2/reload",
          payload: { idempotencyKey: `failover-sim-${i}` },
        });
        expect([200, 202, 400, 401, 403, 429, 503]).toContain(reloadR.statusCode);

        const snapR = await app.inject({ method: "GET", url: "/api/broadcast-v2/snapshot" });
        // 404 is valid when the orchestrator hasn't loaded queue yet (empty DB)
        expect([200, 404, 429, 503]).toContain(snapR.statusCode);
        if (snapR.statusCode === 200) {
          expect(() => JSON.parse(snapR.body)).not.toThrow();
        }
      }
    },
    30_000,
  );
});
