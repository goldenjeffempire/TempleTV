/**
 * Focused load test for the hottest read path: GET /api/broadcast/current.
 *
 * Why this endpoint specifically: it's the one every TV / mobile / web viewer
 * hits on connect AND polls as a belt-and-suspenders refresh on top of SSE.
 * Its cold-rebuild p95 is what the broadcastLatencyWatchdog watches; this
 * script is the synthetic load that lets you confirm the watchdog's
 * thresholds are realistic before you trust them in production.
 *
 * Design constraints:
 *   - Zero new dependencies. Pure Node stdlib (`undici` ships with Node 24
 *     so we use the global `fetch`). Trivial to run inside this monorepo
 *     or against a deployed instance.
 *   - Concurrent-virtual-user model with a wall-clock duration, not a
 *     fixed total request count — closer to how viewer traffic actually
 *     arrives and lets you compare runs directly.
 *   - Per-request latency captured via `performance.now()` (monotonic,
 *     not affected by clock skew), aggregated to p50 / p95 / p99 / max
 *     via a nearest-rank percentile to match the in-process snapshot
 *     the API itself reports under `infrastructure.broadcastBuildLatency`.
 *   - Counts non-2xx separately so a perf number can't be silently
 *     inflated by a fast 5xx.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx ./src/load-test-broadcast-current.ts \
 *     --url=http://localhost:8080/api/broadcast/current \
 *     --concurrency=20 \
 *     --duration-secs=30
 *
 * Defaults: localhost:8080, 10 concurrent VUs, 15 s duration. All flags
 * optional. The script exits non-zero if more than 1% of requests failed,
 * so it's safe to wire into a CI smoke-perf gate.
 */

interface Args {
  url: string;
  concurrency: number;
  durationSecs: number;
  warmupSecs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: process.env.LOAD_TEST_URL ?? "http://localhost:8080/api/broadcast/current",
    concurrency: 10,
    durationSecs: 15,
    warmupSecs: 2,
  };
  for (const raw of argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    if (!k || v === undefined) continue;
    if (k === "url") args.url = v;
    else if (k === "concurrency") args.concurrency = Math.max(1, Number.parseInt(v, 10) || 1);
    else if (k === "duration-secs") args.durationSecs = Math.max(1, Number.parseInt(v, 10) || 1);
    else if (k === "warmup-secs") args.warmupSecs = Math.max(0, Number.parseInt(v, 10) || 0);
  }
  return args;
}

interface VuStats {
  ok: number;
  nonOk: number;
  errors: number;
  latenciesMs: number[];
}

function newStats(): VuStats {
  return { ok: 0, nonOk: 0, errors: 0, latenciesMs: [] };
}

function mergeStats(into: VuStats, from: VuStats) {
  into.ok += from.ok;
  into.nonOk += from.nonOk;
  into.errors += from.errors;
  for (const v of from.latenciesMs) into.latenciesMs.push(v);
}

/** Nearest-rank percentile — matches the in-process broadcastLatency snapshot. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.min(Math.max(rank, 0), sortedAsc.length - 1);
  return sortedAsc[idx]!;
}

async function vuLoop(url: string, deadlineMs: number, capture: boolean, stats: VuStats): Promise<void> {
  while (Date.now() < deadlineMs) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method: "GET" });
      // Drain the body so the connection can be reused — without this,
      // keep-alive doesn't actually help and you're measuring TCP setup
      // cost instead of API behavior.
      await res.arrayBuffer();
      const elapsed = performance.now() - t0;
      if (capture) {
        if (res.ok) stats.ok += 1;
        else stats.nonOk += 1;
        stats.latenciesMs.push(elapsed);
      }
    } catch {
      if (capture) stats.errors += 1;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const { url, concurrency, durationSecs, warmupSecs } = args;

  console.log("Load test: GET %s", url);
  console.log("  concurrency=%d  duration=%ds  warmup=%ds\n", concurrency, durationSecs, warmupSecs);

  // Warm-up phase: fire requests but discard the numbers. Avoids letting
  // the cold-build path (PG pool spin-up, V8 JIT, first cache miss) skew
  // the measurement window. The cold-build path has its OWN measurement
  // surface (the latency snapshot the API exposes) — it's not what this
  // script is for.
  if (warmupSecs > 0) {
    const warmDeadline = Date.now() + warmupSecs * 1000;
    const sink = newStats();
    await Promise.all(
      Array.from({ length: concurrency }, () => vuLoop(url, warmDeadline, false, sink)),
    );
    console.log("Warm-up complete.\n");
  }

  const wallStart = performance.now();
  const deadline = Date.now() + durationSecs * 1000;
  const perVu = Array.from({ length: concurrency }, () => newStats());
  await Promise.all(perVu.map((s) => vuLoop(url, deadline, true, s)));
  const wallElapsedSecs = (performance.now() - wallStart) / 1000;

  const merged = newStats();
  for (const s of perVu) mergeStats(merged, s);

  const total = merged.ok + merged.nonOk + merged.errors;
  merged.latenciesMs.sort((a, b) => a - b);
  const p50 = percentile(merged.latenciesMs, 50);
  const p95 = percentile(merged.latenciesMs, 95);
  const p99 = percentile(merged.latenciesMs, 99);
  const max = merged.latenciesMs.length ? merged.latenciesMs[merged.latenciesMs.length - 1]! : 0;
  const min = merged.latenciesMs.length ? merged.latenciesMs[0]! : 0;
  const rps = total / wallElapsedSecs;
  const failureRate = total > 0 ? (merged.nonOk + merged.errors) / total : 0;

  const fmt = (n: number, w = 7) => n.toFixed(2).padStart(w);
  console.log("Results");
  console.log("  Wall time:     %ds", wallElapsedSecs.toFixed(2));
  console.log("  Total requests: %d", total);
  console.log("  Throughput:     %s req/s", fmt(rps));
  console.log("  Successes (2xx): %d", merged.ok);
  console.log("  Non-2xx:        %d", merged.nonOk);
  console.log("  Network errors: %d", merged.errors);
  console.log("  Failure rate:   %s%%", fmt(failureRate * 100));
  console.log("\nLatency (ms)");
  console.log("  min:   %s", fmt(min));
  console.log("  p50:   %s", fmt(p50));
  console.log("  p95:   %s", fmt(p95));
  console.log("  p99:   %s", fmt(p99));
  console.log("  max:   %s", fmt(max));

  // Soft gate for CI: the hot-path endpoint should never have a non-trivial
  // failure rate under load it was designed for. 1% is a generous ceiling
  // (any real regression would push this to double digits).
  if (failureRate > 0.01) {
    console.error("\nFAIL: failure rate %s%% exceeds 1%% gate.", fmt(failureRate * 100));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});
