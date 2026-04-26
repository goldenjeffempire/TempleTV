import type { NextFunction, Request, Response } from "express";

type MethodStats = {
  total: number;
  errors: number;
  totalMs: number;
};

type RouteStats = {
  method: string;
  path: string;
  total: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  slowCount: number;
  lastStatus: number;
  lastAt: number;
};

type SlowRequestEntry = {
  method: string;
  path: string;
  rawPath: string;
  statusCode: number;
  durationMs: number;
  at: number;
  requestId?: string;
};

const startedAt = Date.now();
const methodStats = new Map<string, MethodStats>();
const routeStats = new Map<string, RouteStats>();
let activeRequests = 0;

const SLOW_REQUEST_THRESHOLD_MS = (() => {
  const raw = Number(process.env.SLOW_REQUEST_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
})();
const SLOW_REQUEST_BUFFER_SIZE = 50;
const SLOW_REQUEST_MAX_AGE_MS = 60 * 60 * 1000; // 1h
const ROUTE_STATS_MAX_KEYS = 500;

const slowRequests: SlowRequestEntry[] = [];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_LONG_RE = /^[0-9a-f]{12,}$/i;
const NUM_RE = /^\d+$/;

/**
 * Collapses high-cardinality URL segments (UUIDs, numeric IDs, long hex hashes)
 * to `:id` so the per-route stats map doesn't explode into thousands of keys
 * for routes like `/api/videos/<uuid>`. Query strings are stripped.
 */
function normalizePath(rawPath: string): string {
  const path = (rawPath || "/").split("?")[0] || "/";
  const segs = path.split("/");
  const normalized = segs.map((seg) => {
    if (!seg) return seg;
    if (UUID_RE.test(seg)) return ":id";
    if (HEX_LONG_RE.test(seg)) return ":id";
    if (NUM_RE.test(seg)) return ":id";
    return seg;
  });
  return normalized.join("/") || "/";
}

function getMethodStats(method: string) {
  const existing = methodStats.get(method);
  if (existing) return existing;
  const created = { total: 0, errors: 0, totalMs: 0 };
  methodStats.set(method, created);
  return created;
}

function getRouteStats(method: string, path: string): RouteStats {
  const key = `${method} ${path}`;
  const existing = routeStats.get(key);
  if (existing) return existing;
  // Defensive cap — if we somehow blow past ROUTE_STATS_MAX_KEYS (e.g. the
  // normalizer missed an unbounded segment), evict the least-recently-touched
  // half so a single rogue caller can't OOM the process.
  if (routeStats.size >= ROUTE_STATS_MAX_KEYS) {
    const sorted = Array.from(routeStats.entries()).sort(
      (a, b) => a[1].lastAt - b[1].lastAt,
    );
    for (let i = 0; i < Math.floor(ROUTE_STATS_MAX_KEYS / 2); i++) {
      routeStats.delete(sorted[i][0]);
    }
  }
  const created: RouteStats = {
    method,
    path,
    total: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    slowCount: 0,
    lastStatus: 0,
    lastAt: 0,
  };
  routeStats.set(key, created);
  return created;
}

function recordSlowRequest(entry: SlowRequestEntry) {
  slowRequests.push(entry);
  if (slowRequests.length > SLOW_REQUEST_BUFFER_SIZE) {
    slowRequests.splice(0, slowRequests.length - SLOW_REQUEST_BUFFER_SIZE);
  }
}

function pruneSlowRequests(now = Date.now()) {
  const cutoff = now - SLOW_REQUEST_MAX_AGE_MS;
  while (slowRequests.length > 0 && slowRequests[0].at < cutoff) {
    slowRequests.shift();
  }
}

export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  activeRequests += 1;
  const start = performance.now();
  const startWallClock = Date.now();

  const finalize = () => {
    activeRequests = Math.max(0, activeRequests - 1);
    const durationMs = performance.now() - start;
    const isError = res.statusCode >= 500;

    const mStats = getMethodStats(req.method);
    mStats.total += 1;
    mStats.totalMs += durationMs;
    if (isError) mStats.errors += 1;

    const rawPath = (req.originalUrl || req.url || "/").split("?")[0];
    const normalized = normalizePath(rawPath);
    const rStats = getRouteStats(req.method, normalized);
    rStats.total += 1;
    rStats.totalMs += durationMs;
    if (durationMs > rStats.maxMs) rStats.maxMs = durationMs;
    if (isError) rStats.errors += 1;
    rStats.lastStatus = res.statusCode;
    rStats.lastAt = startWallClock;

    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      rStats.slowCount += 1;
      const requestId =
        (req as Request & { id?: string }).id ??
        (typeof req.headers["x-request-id"] === "string"
          ? (req.headers["x-request-id"] as string)
          : undefined);
      recordSlowRequest({
        method: req.method,
        path: normalized,
        rawPath,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
        at: startWallClock,
        requestId,
      });
    }
  };

  // `finish` covers the normal completion path; `close` covers client aborts
  // and drained sockets. Guard with a flag so we only record once.
  let recorded = false;
  const once = () => {
    if (recorded) return;
    recorded = true;
    finalize();
  };
  res.on("finish", once);
  res.on("close", once);

  next();
}

export function metricsText(): string {
  const lines = [
    "# HELP temple_tv_uptime_seconds API process uptime in seconds",
    "# TYPE temple_tv_uptime_seconds gauge",
    `temple_tv_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    "# HELP temple_tv_active_requests Current active HTTP requests",
    "# TYPE temple_tv_active_requests gauge",
    `temple_tv_active_requests ${activeRequests}`,
    "# HELP temple_tv_http_requests_total Total HTTP requests by method",
    "# TYPE temple_tv_http_requests_total counter",
  ];

  for (const [method, stats] of methodStats.entries()) {
    const label = `method="${method}"`;
    lines.push(`temple_tv_http_requests_total{${label}} ${stats.total}`);
    lines.push(`temple_tv_http_errors_total{${label}} ${stats.errors}`);
    lines.push(`temple_tv_http_request_duration_ms_sum{${label}} ${Math.round(stats.totalMs)}`);
  }

  return `${lines.join("\n")}\n`;
}

export function metricsSnapshot() {
  const requests = Array.from(methodStats.entries()).map(([method, stats]) => ({
    method,
    total: stats.total,
    errors: stats.errors,
    averageMs: stats.total > 0 ? Math.round(stats.totalMs / stats.total) : 0,
  }));

  return {
    uptimeSecs: Math.floor((Date.now() - startedAt) / 1000),
    activeRequests,
    requests,
  };
}

export function slowRequestsSnapshot() {
  pruneSlowRequests();

  // Top routes by p≈max latency and slow-count, capped at 25 to keep the
  // payload small enough for the 30s admin poll.
  const routes = Array.from(routeStats.values())
    .filter((r) => r.total > 0)
    .map((r) => ({
      method: r.method,
      path: r.path,
      total: r.total,
      errors: r.errors,
      slowCount: r.slowCount,
      averageMs: Math.round(r.totalMs / r.total),
      maxMs: Math.round(r.maxMs),
      lastStatus: r.lastStatus,
      lastAt: r.lastAt,
    }))
    .sort((a, b) => {
      if (b.slowCount !== a.slowCount) return b.slowCount - a.slowCount;
      return b.maxMs - a.maxMs;
    })
    .slice(0, 25);

  // Most-recent slow requests first so the operator sees fresh evidence at
  // the top of the card.
  const entries = [...slowRequests]
    .sort((a, b) => b.at - a.at)
    .map((e) => ({
      method: e.method,
      path: e.path,
      rawPath: e.rawPath,
      statusCode: e.statusCode,
      durationMs: e.durationMs,
      at: new Date(e.at).toISOString(),
      requestId: e.requestId ?? null,
    }));

  return {
    thresholdMs: SLOW_REQUEST_THRESHOLD_MS,
    bufferSize: SLOW_REQUEST_BUFFER_SIZE,
    bufferMaxAgeMs: SLOW_REQUEST_MAX_AGE_MS,
    capturedCount: slowRequests.length,
    entries,
    routes,
  };
}
