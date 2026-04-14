import type { NextFunction, Request, Response } from "express";

type MethodStats = {
  total: number;
  errors: number;
  totalMs: number;
};

const startedAt = Date.now();
const methodStats = new Map<string, MethodStats>();
let activeRequests = 0;

function getStats(method: string) {
  const existing = methodStats.get(method);
  if (existing) return existing;
  const created = { total: 0, errors: 0, totalMs: 0 };
  methodStats.set(method, created);
  return created;
}

export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  activeRequests += 1;
  const start = performance.now();

  res.on("finish", () => {
    activeRequests = Math.max(0, activeRequests - 1);
    const stats = getStats(req.method);
    stats.total += 1;
    stats.totalMs += performance.now() - start;
    if (res.statusCode >= 500) stats.errors += 1;
  });

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