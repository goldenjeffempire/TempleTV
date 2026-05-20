// ─────────────────────────────────────────────────────────────────────────────
//  scripts/analyze-access-log.ts
//
//  Production-log triage helper. Reads a Render log paste (mixed pino JSON
//  request lines + Render edge-log lines) from a file path or stdin and
//  prints a per-URL response-size summary, sorted by max bytes desc.
//
//  Why this exists:
//    Render's edge access log records `responseBytes=…` but NOT the URL or
//    status. Pino's request log records URL + status but historically NOT
//    bytes. The 2026-04-27 production triage of `temple-tv-api` saw a flood
//    of identical 223,158-byte responses in the edge log and could not
//    correlate them to a route. With the new `bytes` field added to the
//    pino response serializer (artifacts/api-server/src/app.ts), every
//    request line now has `"res":{"statusCode":N,"bytes":M}` and a single
//    grep can pinpoint the offending route. This script automates that:
//      • parses pino JSON lines (skips Render edge lines, build lines,
//        boot lines, anything non-JSON)
//      • groups by URL (path only, query already stripped server-side)
//      • prints `count │ max bytes │ p95 bytes │ total bytes │ method │ url`
//        sorted by max bytes desc
//      • supports an optional `--min N` flag to filter out small responses
//
//  Usage:
//    pnpm --filter @workspace/scripts exec tsx ./src/analyze-access-log.ts <log-file>
//    cat render-log.txt | pnpm --filter @workspace/scripts exec tsx ./src/analyze-access-log.ts
//    pnpm --filter @workspace/scripts exec tsx ./src/analyze-access-log.ts --min 100000 <log-file>
//
//  Designed to be standalone — uses only Node built-ins, no external deps.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readSync } from "node:fs";

interface PinoRequestLine {
  level?: number;
  msg?: string;
  req?: { method?: string; url?: string };
  res?: { statusCode?: number; bytes?: number };
  responseTime?: number;
}

interface UrlStats {
  url: string;
  method: string;
  count: number;
  maxBytes: number;
  totalBytes: number;
  bytesSamples: number[];
  statusCodes: Map<number, number>;
}

const args = process.argv.slice(2);
let minBytes = 0;
const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--min" && i + 1 < args.length) {
    const next = args[i + 1];
    if (next !== undefined) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed >= 0) minBytes = parsed;
    }
    i += 1;
  } else if (arg === "--" || arg === undefined) {
    // bare `--` is a pnpm/npm arg separator, not a path — ignore it
  } else {
    positional.push(arg);
  }
}

function readInput(): string {
  if (positional.length > 0 && positional[0] !== undefined) {
    return readFileSync(positional[0], "utf8");
  }
  // stdin
  const chunks: Buffer[] = [];
  const fd = 0;
  // Synchronous stdin read — log files are small enough (10s of MB at most)
  // that streaming would only add complexity. We read once, parse once, exit.
  const buf = Buffer.alloc(64 * 1024);
   
  while (true) {
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tryParsePino(line: string): PinoRequestLine | null {
  // Pino JSON lines start with `{"level":` and have a trailing `}`.
  // Render lines start with a timestamp like `2026-04-27T16:09:02Z` (no `{`)
  // or `==>`, so this filter is fast and unambiguous.
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as PinoRequestLine;
    return obj;
  } catch {
    // Some logs wrap JSON in a timestamp prefix from the platform — try
    // stripping a leading `<iso-ts> ` and re-parsing once.
    const idx = trimmed.indexOf("{");
    if (idx > 0) {
      try {
        return JSON.parse(trimmed.slice(idx)) as PinoRequestLine;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function p95(sortedAsc: readonly number[]): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * 0.95));
  return sortedAsc[idx] ?? 0;
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function main(): void {
  const raw = readInput();
  if (!raw.trim()) {
    process.stderr.write("No input — pass a log file path or pipe via stdin.\n");
    process.exit(2);
  }
  const stats = new Map<string, UrlStats>();
  let pinoLines = 0;
  let requestLines = 0;
  let withBytes = 0;
  for (const line of raw.split(/\r?\n/)) {
    const obj = tryParsePino(line);
    if (!obj) continue;
    pinoLines += 1;
    if (!obj.req || !obj.res || obj.msg !== "request completed") continue;
    requestLines += 1;
    const url = obj.req.url ?? "(unknown)";
    const method = obj.req.method ?? "?";
    const status = obj.res.statusCode ?? 0;
    const bytes = typeof obj.res.bytes === "number" ? obj.res.bytes : 0;
    if (bytes > 0) withBytes += 1;
    if (bytes < minBytes) continue;
    const key = `${method} ${url}`;
    let s = stats.get(key);
    if (!s) {
      s = {
        url,
        method,
        count: 0,
        maxBytes: 0,
        totalBytes: 0,
        bytesSamples: [],
        statusCodes: new Map(),
      };
      stats.set(key, s);
    }
    s.count += 1;
    s.maxBytes = Math.max(s.maxBytes, bytes);
    s.totalBytes += bytes;
    s.bytesSamples.push(bytes);
    s.statusCodes.set(status, (s.statusCodes.get(status) ?? 0) + 1);
  }

  const rows = Array.from(stats.values()).sort((a, b) => b.maxBytes - a.maxBytes);

  process.stdout.write(`\nParsed: ${pinoLines} pino JSON lines, ${requestLines} request-completed lines, ${withBytes} with bytes field${minBytes > 0 ? ` (filtering bytes >= ${minBytes})` : ""}\n\n`);

  if (rows.length === 0) {
    process.stdout.write("No matching request lines. If your pino logs do not yet have a `bytes` field, redeploy with the updated artifacts/api-server/src/app.ts response serializer first.\n");
    return;
  }

  const header = ["count", "max", "p95", "total", "status", "method", "url"];
  const widths = [6, 9, 9, 11, 16, 7, 0];
  const fmt = (cells: readonly string[]): string =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? 0;
        return i === cells.length - 1 ? c : c.padEnd(w);
      })
      .join("  ");
  process.stdout.write(`${fmt(header)}\n`);
  process.stdout.write(`${fmt(header.map((h, i) => "─".repeat(Math.max(h.length, widths[i] ?? 0))))}\n`);

  for (const r of rows) {
    const sorted = [...r.bytesSamples].sort((a, b) => a - b);
    const statusSummary = Array.from(r.statusCodes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code}×${n}`)
      .join(",");
    process.stdout.write(
      `${fmt([
        String(r.count),
        humanBytes(r.maxBytes),
        humanBytes(p95(sorted)),
        humanBytes(r.totalBytes),
        statusSummary,
        r.method,
        r.url,
      ])}\n`,
    );
  }
}

main();
