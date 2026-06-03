#!/usr/bin/env tsx
/**
 * Load test for the broadcast-v2 SSE and REST endpoints.
 *
 * Simulates concurrent virtual users connecting to:
 *   - GET /api/broadcast-v2/events  (SSE — long-lived connections)
 *   - GET /api/broadcast-v2/health  (REST — polled every N seconds)
 *   - GET /api/broadcast-v2/snapshot (REST — polled on reconnect)
 *
 * Measures:
 *   - SSE connection establishment latency (p50 / p95 / p99)
 *   - Time-to-first-event (snapshot latency)
 *   - Events received per second (aggregate throughput)
 *   - Reconnection success rate after forced disconnect
 *   - REST endpoint latency under concurrent SSE load
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx ./src/load-test-broadcast-v2.ts \
 *     --url=http://localhost:8080 \
 *     --sse-clients=50 \
 *     --rest-clients=20 \
 *     --duration-secs=60
 *
 * Defaults: localhost:8080, 20 SSE clients, 10 REST clients, 30 s.
 */

import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    "sse-clients": { type: "string", default: "20" },
    "rest-clients": { type: "string", default: "10" },
    "duration-secs": { type: "string", default: "30" },
    "reconnect-interval-ms": { type: "string", default: "10000" },
  },
});

const BASE_URL = values["url"] as string;
const SSE_CLIENTS = parseInt(values["sse-clients"] as string, 10);
const REST_CLIENTS = parseInt(values["rest-clients"] as string, 10);
const DURATION_MS = parseInt(values["duration-secs"] as string, 10) * 1000;
const RECONNECT_INTERVAL_MS = parseInt(values["reconnect-interval-ms"] as string, 10);

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface Stats {
  sseConnectMs: number[];
  sseFirstEventMs: number[];
  sseEventsTotal: number;
  sseDisconnects: number;
  sseReconnects: number;
  sseReconnectFailures: number;
  restLatencyMs: number[];
  restErrors: number;
  restTotal: number;
}

const stats: Stats = {
  sseConnectMs: [],
  sseFirstEventMs: [],
  sseEventsTotal: 0,
  sseDisconnects: 0,
  sseReconnects: 0,
  sseReconnectFailures: 0,
  restLatencyMs: [],
  restErrors: 0,
  restTotal: 0,
};

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// SSE virtual user
// ---------------------------------------------------------------------------

async function sseVirtualUser(id: number, stopAt: number): Promise<void> {
  let lastSeq = 0;

  async function connect(isReconnect = false): Promise<void> {
    if (Date.now() >= stopAt) return;
    const url = `${BASE_URL}/api/broadcast-v2/events${lastSeq > 0 ? `?lastSequence=${lastSeq}` : ""}`;
    const connectStart = performance.now();

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), Math.max(0, stopAt - Date.now() + 1000));

    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        if (isReconnect) stats.sseReconnectFailures++;
        return;
      }

      stats.sseConnectMs.push(performance.now() - connectStart);
      if (isReconnect) stats.sseReconnects++;

      let firstEventReceived = false;
      const firstEventStart = performance.now();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (Date.now() < stopAt) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        // Process complete SSE messages (delimited by double newline)
        const messages = buf.split("\n\n");
        buf = messages.pop() ?? "";

        for (const msg of messages) {
          if (!msg.trim()) continue;
          stats.sseEventsTotal++;

          if (!firstEventReceived) {
            firstEventReceived = true;
            stats.sseFirstEventMs.push(performance.now() - firstEventStart);
          }

          // Extract sequence number for resume support
          const idMatch = msg.match(/^id: (\d+)/m);
          if (idMatch) lastSeq = parseInt(idMatch[1]!, 10);
        }
      }

      reader.cancel().catch(() => {});
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") {
        // Expected when duration expires or deadline fires.
        return;
      }
      if (isReconnect) stats.sseReconnectFailures++;
    } finally {
      clearTimeout(deadline);
      if (Date.now() < stopAt) stats.sseDisconnects++;
    }
  }

  await connect(false);

  // Reconnect loop
  while (Date.now() < stopAt) {
    const gap = RECONNECT_INTERVAL_MS + Math.random() * 2000; // jitter
    await new Promise((r) => setTimeout(r, gap));
    if (Date.now() >= stopAt) break;
    await connect(true);
  }
}

// ---------------------------------------------------------------------------
// REST virtual user
// ---------------------------------------------------------------------------

async function restVirtualUser(stopAt: number): Promise<void> {
  const endpoints = [
    `${BASE_URL}/api/broadcast-v2/health`,
    `${BASE_URL}/api/broadcast-v2/snapshot`,
  ];
  let idx = 0;

  while (Date.now() < stopAt) {
    const url = endpoints[idx % endpoints.length]!;
    idx++;
    const start = performance.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      stats.restLatencyMs.push(performance.now() - start);
      stats.restTotal++;
      if (!res.ok) stats.restErrors++;
    } catch {
      stats.restErrors++;
      stats.restTotal++;
    }
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n🚀  Broadcast-v2 Load Test`);
  console.log(`   Target:      ${BASE_URL}`);
  console.log(`   SSE clients: ${SSE_CLIENTS}`);
  console.log(`   REST clients: ${REST_CLIENTS}`);
  console.log(`   Duration:    ${DURATION_MS / 1000} s\n`);

  // Verify server is reachable before spawning workers
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Healthz returned ${res.status}`);
    console.log("   ✓ Server is reachable\n");
  } catch (err) {
    console.error(`❌  Cannot reach ${BASE_URL}:`, (err as Error).message);
    console.error("   Start the API first: pnpm --filter @workspace/api-server run build && PORT=8080 node ...");
    process.exit(1);
  }

  const stopAt = Date.now() + DURATION_MS;

  const workers: Promise<void>[] = [
    ...Array.from({ length: SSE_CLIENTS }, (_, i) => sseVirtualUser(i, stopAt)),
    ...Array.from({ length: REST_CLIENTS }, () => restVirtualUser(stopAt)),
  ];

  // Progress ticker
  const ticker = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((stopAt - Date.now()) / 1000));
    process.stdout.write(
      `\r   ${remaining}s remaining | SSE events: ${stats.sseEventsTotal} | REST req: ${stats.restTotal} | Reconnects: ${stats.sseReconnects}   `,
    );
  }, 1000);

  await Promise.allSettled(workers);
  clearInterval(ticker);
  process.stdout.write("\n\n");

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  const elapsed = DURATION_MS / 1000;

  console.log("═══════════════════════════════════════════════════════");
  console.log("  BROADCAST-V2 LOAD TEST RESULTS");
  console.log("═══════════════════════════════════════════════════════");

  console.log("\n  SSE Connections");
  console.log(`    Total attempts    : ${SSE_CLIENTS + stats.sseReconnects}`);
  console.log(`    Reconnects        : ${stats.sseReconnects}`);
  console.log(`    Reconnect failures: ${stats.sseReconnectFailures}`);
  if (stats.sseReconnects > 0) {
    const successRate = ((stats.sseReconnects / (stats.sseReconnects + stats.sseReconnectFailures)) * 100).toFixed(1);
    console.log(`    Reconnect success : ${successRate}%`);
  }

  console.log("\n  SSE Connect Latency");
  console.log(`    Samples : ${stats.sseConnectMs.length}`);
  console.log(`    Avg     : ${avg(stats.sseConnectMs).toFixed(1)} ms`);
  console.log(`    p50     : ${pct(stats.sseConnectMs, 50).toFixed(1)} ms`);
  console.log(`    p95     : ${pct(stats.sseConnectMs, 95).toFixed(1)} ms`);
  console.log(`    p99     : ${pct(stats.sseConnectMs, 99).toFixed(1)} ms`);

  console.log("\n  SSE Time-to-First-Event");
  console.log(`    Samples : ${stats.sseFirstEventMs.length}`);
  console.log(`    Avg     : ${avg(stats.sseFirstEventMs).toFixed(1)} ms`);
  console.log(`    p50     : ${pct(stats.sseFirstEventMs, 50).toFixed(1)} ms`);
  console.log(`    p95     : ${pct(stats.sseFirstEventMs, 95).toFixed(1)} ms`);
  console.log(`    p99     : ${pct(stats.sseFirstEventMs, 99).toFixed(1)} ms`);

  console.log("\n  SSE Throughput");
  console.log(`    Total events  : ${stats.sseEventsTotal}`);
  console.log(`    Events/sec    : ${(stats.sseEventsTotal / elapsed).toFixed(1)}`);
  console.log(`    Events/client : ${(stats.sseEventsTotal / SSE_CLIENTS / elapsed).toFixed(2)} /s`);

  console.log("\n  REST Endpoints");
  console.log(`    Total requests: ${stats.restTotal}`);
  console.log(`    Errors        : ${stats.restErrors}`);
  if (stats.restTotal > 0) {
    console.log(`    Error rate    : ${((stats.restErrors / stats.restTotal) * 100).toFixed(1)}%`);
  }
  console.log(`    Avg latency   : ${avg(stats.restLatencyMs).toFixed(1)} ms`);
  console.log(`    p95 latency   : ${pct(stats.restLatencyMs, 95).toFixed(1)} ms`);
  console.log(`    p99 latency   : ${pct(stats.restLatencyMs, 99).toFixed(1)} ms`);

  // Pass/fail thresholds
  console.log("\n  Quality Gates");
  const connectP95 = pct(stats.sseConnectMs, 95);
  const firstEventP95 = pct(stats.sseFirstEventMs, 95);
  const restP95 = pct(stats.restLatencyMs, 95);
  const reconnectFailPct = stats.sseReconnects > 0
    ? (stats.sseReconnectFailures / (stats.sseReconnects + stats.sseReconnectFailures)) * 100
    : 0;

  const gates = [
    { name: "SSE connect p95 < 2 000 ms", pass: connectP95 < 2000, value: `${connectP95.toFixed(0)} ms` },
    { name: "SSE first-event p95 < 3 000 ms", pass: firstEventP95 < 3000, value: `${firstEventP95.toFixed(0)} ms` },
    { name: "REST p95 < 500 ms", pass: restP95 < 500, value: `${restP95.toFixed(0)} ms` },
    { name: "Reconnect failure rate < 5%", pass: reconnectFailPct < 5, value: `${reconnectFailPct.toFixed(1)}%` },
    { name: "REST error rate < 1%", pass: stats.restTotal === 0 || (stats.restErrors / stats.restTotal) < 0.01, value: `${stats.restTotal === 0 ? "N/A" : ((stats.restErrors / stats.restTotal) * 100).toFixed(1) + "%"}` },
  ];

  let allPassed = true;
  for (const gate of gates) {
    const icon = gate.pass ? "✓" : "✗";
    console.log(`    ${icon} ${gate.name} — ${gate.value}`);
    if (!gate.pass) allPassed = false;
  }

  console.log("\n═══════════════════════════════════════════════════════\n");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
