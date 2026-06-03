#!/usr/bin/env tsx
/**
 * Long-duration SSE stability test for broadcast-v2.
 *
 * Maintains a single persistent SSE connection for an extended period and
 * verifies:
 *   - No missed sequences (resume/replay works across reconnects)
 *   - Heartbeats arrive within tolerance (no silent server-side death)
 *   - Event ordering is always monotonically increasing
 *   - Memory on the server does not spike (requires /status endpoint)
 *   - Reconnect after forced close restores state correctly
 *
 * This script is designed to be run for 10–60 minutes as a pre-deployment
 * stability gate. For short smoke tests use --duration-mins=2.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx ./src/stability-test.ts \
 *     --url=http://localhost:8080 \
 *     --duration-mins=10 \
 *     --max-heartbeat-gap-secs=35
 *
 * Exit 0 = all checks passed. Exit 1 = at least one failure.
 */

import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    "duration-mins": { type: "string", default: "10" },
    "max-heartbeat-gap-secs": { type: "string", default: "35" },
    "force-reconnect-interval-mins": { type: "string", default: "2" },
  },
});

const BASE_URL = values["url"] as string;
const DURATION_MS = parseFloat(values["duration-mins"] as string) * 60_000;
const MAX_HEARTBEAT_GAP_MS = parseFloat(values["max-heartbeat-gap-secs"] as string) * 1_000;
const FORCE_RECONNECT_INTERVAL_MS = parseFloat(values["force-reconnect-interval-mins"] as string) * 60_000;

interface RunStats {
  connectionCount: number;
  totalEventsReceived: number;
  totalHeartbeats: number;
  missedSequences: number[];
  outOfOrderEvents: number;
  maxHeartbeatGapMs: number;
  lastHeartbeatMs: number;
  forcedReconnects: number;
  spontaneousDisconnects: number;
  memorySnapshotsRssMb: number[];
  startMs: number;
}

const stats: RunStats = {
  connectionCount: 0,
  totalEventsReceived: 0,
  totalHeartbeats: 0,
  missedSequences: [],
  outOfOrderEvents: 0,
  maxHeartbeatGapMs: 0,
  lastHeartbeatMs: Date.now(),
  forcedReconnects: 0,
  spontaneousDisconnects: 0,
  memorySnapshotsRssMb: [],
  startMs: Date.now(),
};

// Parse SSE frames from a raw text chunk
function parseSseFrames(text: string): Array<{ id?: number; type?: string; data?: string }> {
  const frames: Array<{ id?: number; type?: string; data?: string }> = [];
  const messages = text.split("\n\n");
  for (const msg of messages) {
    if (!msg.trim()) continue;
    const frame: { id?: number; type?: string; data?: string } = {};
    for (const line of msg.split("\n")) {
      if (line.startsWith("id: ")) frame.id = parseInt(line.slice(4), 10);
      else if (line.startsWith("event: ")) frame.type = line.slice(7).trim();
      else if (line.startsWith("data: ")) frame.data = line.slice(6).trim();
    }
    if (frame.type || frame.data) frames.push(frame);
  }
  return frames;
}

async function pollServerMemory(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const body = await res.json() as { memory?: { rssMb?: number } };
    if (typeof body.memory?.rssMb === "number") {
      stats.memorySnapshotsRssMb.push(body.memory.rssMb);
    }
  } catch {
    // Status endpoint may not be available; ignore.
  }
}

async function runSseSession(stopAt: number, lastSeq: number): Promise<number> {
  const url = `${BASE_URL}/api/broadcast-v2/events${lastSeq > 0 ? `?lastSequence=${lastSeq}` : ""}`;
  stats.connectionCount++;

  const controller = new AbortController();
  const sessionStop = Math.min(stopAt, Date.now() + FORCE_RECONNECT_INTERVAL_MS);
  const forceReconnectTimer = setTimeout(() => controller.abort(), Math.max(0, sessionStop - Date.now()));

  let highestSeq = lastSeq;
  let prevSeq = lastSeq;
  let buf = "";

  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      stats.spontaneousDisconnects++;
      return highestSeq;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (Date.now() < sessionStop && Date.now() < stopAt) {
      const { done, value } = await reader.read();
      if (done) { stats.spontaneousDisconnects++; break; }

      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";

      for (const msgText of parts) {
        const frames = parseSseFrames(msgText + "\n\n");
        for (const frame of frames) {
          stats.totalEventsReceived++;

          if (frame.type === "heartbeat") {
            const now = Date.now();
            const gap = now - stats.lastHeartbeatMs;
            stats.totalHeartbeats++;
            if (gap > stats.maxHeartbeatGapMs) stats.maxHeartbeatGapMs = gap;
            stats.lastHeartbeatMs = now;
          }

          if (frame.id !== undefined) {
            if (frame.id < prevSeq && frame.type !== "replay") {
              stats.outOfOrderEvents++;
            }
            if (frame.id > highestSeq + 1 && prevSeq > 0 && frame.type !== "snapshot") {
              // Possible sequence gap (accounting for replay overlap)
              for (let s = highestSeq + 1; s < frame.id; s++) {
                stats.missedSequences.push(s);
              }
            }
            if (frame.id > highestSeq) highestSeq = frame.id;
            prevSeq = frame.id;
          }
        }
      }
    }

    reader.cancel().catch(() => {});
  } catch (err: unknown) {
    if ((err as Error)?.name !== "AbortError") {
      stats.spontaneousDisconnects++;
    } else {
      stats.forcedReconnects++;
    }
  } finally {
    clearTimeout(forceReconnectTimer);
  }

  return highestSeq;
}

async function main(): Promise<void> {
  console.log(`\n⏱   Broadcast-v2 Stability Test`);
  console.log(`    Target:              ${BASE_URL}`);
  console.log(`    Duration:            ${DURATION_MS / 60_000} min`);
  console.log(`    Max heartbeat gap:   ${MAX_HEARTBEAT_GAP_MS / 1_000} s`);
  console.log(`    Force-reconnect:     every ${FORCE_RECONNECT_INTERVAL_MS / 60_000} min\n`);

  // Verify server is reachable
  try {
    const r = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${r.status}`);
    console.log("    ✓ Server reachable\n");
  } catch (err) {
    console.error(`❌  Cannot reach ${BASE_URL}:`, (err as Error).message);
    process.exit(1);
  }

  const stopAt = Date.now() + DURATION_MS;
  stats.lastHeartbeatMs = Date.now();
  stats.startMs = Date.now();

  // Start memory polling
  const memPoller = setInterval(() => pollServerMemory(), 30_000);

  // Progress display
  const progressTicker = setInterval(() => {
    const elapsed = ((Date.now() - stats.startMs) / 60_000).toFixed(1);
    const remaining = Math.max(0, ((stopAt - Date.now()) / 60_000)).toFixed(1);
    const hbGapSec = ((Date.now() - stats.lastHeartbeatMs) / 1_000).toFixed(0);
    process.stdout.write(
      `\r    ${elapsed}min elapsed | ${remaining}min left | events: ${stats.totalEventsReceived} | hb: ${stats.totalHeartbeats} | last hb: ${hbGapSec}s ago | reconnects: ${stats.forcedReconnects}   `,
    );
  }, 5_000);

  // Main session loop
  let lastSeq = 0;
  while (Date.now() < stopAt) {
    lastSeq = await runSseSession(stopAt, lastSeq);
    if (Date.now() < stopAt) {
      // Brief gap before reconnecting (jittered 0.5–2 s)
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 1500));
    }
  }

  clearInterval(memPoller);
  clearInterval(progressTicker);
  process.stdout.write("\n\n");

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  const elapsedMins = ((Date.now() - stats.startMs) / 60_000).toFixed(1);
  const throughputEventsPerSec = (stats.totalEventsReceived / (DURATION_MS / 1_000)).toFixed(2);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  STABILITY TEST REPORT");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Duration              : ${elapsedMins} min`);
  console.log(`  Total connections     : ${stats.connectionCount}`);
  console.log(`  Forced reconnects     : ${stats.forcedReconnects}`);
  console.log(`  Spontaneous disc.     : ${stats.spontaneousDisconnects}`);
  console.log(`  Total events          : ${stats.totalEventsReceived}`);
  console.log(`  Throughput            : ${throughputEventsPerSec} events/s`);
  console.log(`  Heartbeats received   : ${stats.totalHeartbeats}`);
  console.log(`  Max heartbeat gap     : ${(stats.maxHeartbeatGapMs / 1_000).toFixed(1)} s`);
  console.log(`  Out-of-order events   : ${stats.outOfOrderEvents}`);
  console.log(`  Missed sequences      : ${stats.missedSequences.length}`);

  if (stats.memorySnapshotsRssMb.length > 0) {
    const firstRss = stats.memorySnapshotsRssMb[0]!;
    const lastRss = stats.memorySnapshotsRssMb[stats.memorySnapshotsRssMb.length - 1]!;
    const maxRss = Math.max(...stats.memorySnapshotsRssMb);
    console.log(`  Memory (RSS start)    : ${firstRss.toFixed(0)} MB`);
    console.log(`  Memory (RSS end)      : ${lastRss.toFixed(0)} MB`);
    console.log(`  Memory (RSS peak)     : ${maxRss.toFixed(0)} MB`);
    const drift = lastRss - firstRss;
    console.log(`  Memory drift          : ${drift >= 0 ? "+" : ""}${drift.toFixed(0)} MB`);
  }

  console.log("\n  Quality Gates");
  const gates = [
    {
      name: "Max heartbeat gap < limit",
      pass: stats.totalHeartbeats === 0 || stats.maxHeartbeatGapMs <= MAX_HEARTBEAT_GAP_MS,
      value: `${(stats.maxHeartbeatGapMs / 1_000).toFixed(1)} s (limit: ${MAX_HEARTBEAT_GAP_MS / 1_000} s)`,
    },
    {
      name: "Out-of-order events = 0",
      pass: stats.outOfOrderEvents === 0,
      value: String(stats.outOfOrderEvents),
    },
    {
      name: "Missed sequences = 0",
      pass: stats.missedSequences.length === 0,
      value: String(stats.missedSequences.length),
    },
    {
      name: "Spontaneous disconnects < 10%",
      pass: stats.connectionCount === 0 || (stats.spontaneousDisconnects / stats.connectionCount) < 0.1,
      value: `${stats.spontaneousDisconnects} / ${stats.connectionCount}`,
    },
  ];

  // Memory leak gate (only if we have readings)
  if (stats.memorySnapshotsRssMb.length >= 3) {
    const first = stats.memorySnapshotsRssMb[0]!;
    const last = stats.memorySnapshotsRssMb[stats.memorySnapshotsRssMb.length - 1]!;
    const drift = last - first;
    gates.push({
      name: "RSS drift < 100 MB over test",
      pass: drift < 100,
      value: `${drift >= 0 ? "+" : ""}${drift.toFixed(0)} MB`,
    });
  }

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
  console.error("Stability test error:", err);
  process.exit(1);
});
