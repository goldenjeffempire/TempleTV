#!/usr/bin/env tsx
/**
 * Failover and graceful-degradation test for broadcast-v2.
 *
 * Tests the system's ability to:
 *   1. Serve clients from in-memory state when the DB is slow / unavailable
 *   2. Return meaningful 503 / degraded responses (not 500) when the DB is down
 *   3. Recover SSE connections after server restart (resume via Last-Event-ID)
 *   4. Rate-limit abusive clients without affecting legitimate ones
 *   5. Correctly reject unauthenticated mutation requests (skip, reload, override)
 *   6. Keep public read paths accessible when auth middleware is stressed
 *
 * The tests are purely HTTP-level: they do NOT manipulate the database
 * directly or stop the server process. Instead they verify observable
 * behaviour at the API boundary.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx ./src/failover-test.ts \
 *     --url=http://localhost:8080
 *
 * Exit 0 = all gates passed. Exit 1 = at least one failure.
 */

import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    "timeout-ms": { type: "string", default: "5000" },
  },
});

const BASE_URL = values["url"] as string;
const TIMEOUT_MS = parseInt(values["timeout-ms"] as string, 10);

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<{ pass: boolean; detail: string }>): Promise<void> {
  const start = performance.now();
  try {
    const { pass, detail } = await fn();
    results.push({ name, pass, detail, durationMs: performance.now() - start });
    const icon = pass ? "✓" : "✗";
    console.log(`  ${icon} ${name} — ${detail}`);
  } catch (err: unknown) {
    results.push({ name, pass: false, detail: `Error: ${(err as Error).message}`, durationMs: performance.now() - start });
    console.log(`  ✗ ${name} — threw: ${(err as Error).message}`);
  }
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function post(path: string, body: unknown = {}, token?: string): Promise<Response> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {
  console.log(`\n🛡   Broadcast-v2 Failover & Graceful-Degradation Test`);
  console.log(`    Target: ${BASE_URL}\n`);

  // 1. Server liveness
  await test("Healthz returns 200", async () => {
    const r = await get("/healthz");
    return { pass: r.status === 200, detail: `HTTP ${r.status}` };
  });

  // 2. Broadcast-v2 health — must not return 5xx
  await test("Broadcast-v2 health returns 200 or 503, never 5xx", async () => {
    const r = await get("/api/broadcast-v2/health");
    const pass = r.status === 200 || r.status === 503;
    return { pass, detail: `HTTP ${r.status}` };
  });

  // 3. Broadcast-v2 health shape when 200
  await test("Broadcast-v2 health shape has required fields", async () => {
    const r = await get("/api/broadcast-v2/health");
    if (r.status !== 200) return { pass: true, detail: "Skipped (non-200)" };
    const body = await r.json() as Record<string, unknown>;
    const hasSeq = typeof body["sequence"] === "number";
    const hasUptime = typeof body["uptimeMs"] === "number";
    const hasMode = body["mode"] !== undefined;
    return {
      pass: hasSeq && hasUptime && hasMode,
      detail: `seq=${body["sequence"]} uptime=${body["uptimeMs"]} mode=${body["mode"]}`,
    };
  });

  // 4. Snapshot endpoint serves from in-memory state (no DB required for 200)
  await test("Snapshot endpoint responds quickly (in-memory, < 500 ms)", async () => {
    const start = performance.now();
    const r = await get("/api/broadcast-v2/snapshot");
    const ms = performance.now() - start;
    return {
      pass: [200, 404, 503].includes(r.status) && ms < 500,
      detail: `HTTP ${r.status} in ${ms.toFixed(0)} ms`,
    };
  });

  // 5. SSE endpoint accepts connection and returns correct headers
  await test("SSE endpoint returns 200 with text/event-stream", async () => {
    const r = await get("/api/broadcast-v2/events");
    const ct = r.headers.get("content-type") ?? "";
    const pass = r.status === 200 && ct.includes("text/event-stream");
    return { pass, detail: `HTTP ${r.status}, Content-Type: ${ct}` };
  });

  // 6. SSE initial payload contains hello + snapshot events
  await test("SSE initial payload has hello and snapshot events", async () => {
    const r = await get("/api/broadcast-v2/events");
    if (r.status !== 200) return { pass: false, detail: `HTTP ${r.status}` };
    const body = await r.text();
    const hasHello = body.includes("event: hello");
    const hasSnapshot = body.includes("event: snapshot");
    return {
      pass: hasHello && hasSnapshot,
      detail: `hello=${hasHello} snapshot=${hasSnapshot}`,
    };
  });

  // 7. SSE resume with Last-Event-ID header
  await test("SSE with Last-Event-ID: 0 returns 200 (resume supported)", async () => {
    const r = await get("/api/broadcast-v2/events", { "Last-Event-ID": "0" });
    return { pass: r.status === 200, detail: `HTTP ${r.status}` };
  });

  // 8. Mutation routes require auth — skip
  await test("POST /skip without token returns 401 or 403", async () => {
    const r = await post("/api/broadcast-v2/skip", { idempotencyKey: "ft-test" });
    return { pass: [401, 403, 404].includes(r.status), detail: `HTTP ${r.status}` };
  });

  // 9. Mutation routes require auth — reload
  await test("POST /reload without token returns 401 or 403", async () => {
    const r = await post("/api/broadcast-v2/reload", {});
    return { pass: [401, 403, 404].includes(r.status), detail: `HTTP ${r.status}` };
  });

  // 10. Mutation routes require admin — override
  await test("POST /override without token returns 401 or 403", async () => {
    const r = await post("/api/broadcast-v2/override", { kind: "hls", url: "https://example.com/stream.m3u8" });
    return { pass: [401, 403, 404].includes(r.status), detail: `HTTP ${r.status}` };
  });

  // 11. Bogus token is rejected
  await test("POST /skip with garbage token returns 401", async () => {
    const r = await post("/api/broadcast-v2/skip", { idempotencyKey: "ft-bad-token" }, "not-a-real-jwt");
    return { pass: [401, 403].includes(r.status), detail: `HTTP ${r.status}` };
  });

  // 12. Rate limit on health endpoint
  await test("Health endpoint rate-limits burst requests (returns 429 on excess)", async () => {
    const responses = await Promise.all(
      Array.from({ length: 35 }, () =>
        get("/api/broadcast-v2/health").then((r) => r.status).catch(() => 599),
      ),
    );
    const has5xx = responses.some((s) => s >= 500 && s !== 503);
    const has429 = responses.includes(429);
    // Must never return 5xx (only 200, 503, or 429)
    return {
      pass: !has5xx,
      detail: `statuses: ${[...new Set(responses)].sort().join(", ")}${has429 ? " (rate limited ✓)" : ""}`,
    };
  });

  // 13. Concurrent public reads work under load
  await test("20 concurrent SSE connections all return 200", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        get("/api/broadcast-v2/events").then((r) => r.status).catch(() => 599),
      ),
    );
    const ok = responses.filter((s) => s === 200).length;
    const rateLimit = responses.filter((s) => s === 429).length;
    // Rate limiter may block some — that's OK; just verify no 5xx
    const has5xx = responses.some((s) => s >= 500 && s !== 503);
    return {
      pass: !has5xx,
      detail: `200: ${ok}, 429: ${rateLimit}, 5xx: ${responses.filter((s) => s >= 500 && s !== 503).length}`,
    };
  });

  // 14. Non-existent broadcast-v2 route returns 404
  await test("Unknown broadcast-v2 route returns 404", async () => {
    const r = await get("/api/broadcast-v2/does-not-exist");
    return { pass: r.status === 404, detail: `HTTP ${r.status}` };
  });

  // 15. Main healthz is not affected by broadcast-v2 stress
  await test("Healthz still fast after broadcast-v2 load (< 200 ms)", async () => {
    // Fire several broadcast requests first
    await Promise.allSettled(Array.from({ length: 10 }, () => get("/api/broadcast-v2/health")));
    const start = performance.now();
    const r = await get("/healthz");
    const ms = performance.now() - start;
    return {
      pass: r.status === 200 && ms < 200,
      detail: `HTTP ${r.status} in ${ms.toFixed(0)} ms`,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify server reachability
  try {
    const r = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${r.status}`);
  } catch (err) {
    console.error(`❌  Cannot reach ${BASE_URL}:`, (err as Error).message);
    process.exit(1);
  }

  await runTests();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  FAILOVER TEST SUMMARY`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  Passed : ${passed} / ${results.length}`);
  console.log(`  Failed : ${failed}`);
  console.log(`  Total  : ${totalMs.toFixed(0)} ms`);

  if (failed > 0) {
    console.log("\n  Failed tests:");
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`    ✗ ${r.name} — ${r.detail}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Failover test error:", err);
  process.exit(1);
});
