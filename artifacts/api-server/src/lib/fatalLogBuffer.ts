/**
 * Fatal log circular buffer — per-role, distributed-cache backed.
 *
 * Why this exists
 * ───────────────
 * On Render, the API and worker run as SEPARATE services with their own
 * stdout streams. When the worker crashloops, the only way an operator
 * sees the fatal line is by opening the Render dashboard and switching
 * between services. By the time you do that, the line may have scrolled
 * off the live tail.
 *
 * This module captures the most recent N `logger.fatal(...)` calls into
 * the shared distributed cache, tagged by RUN_MODE. The API process can
 * then read BOTH its own buffer and the worker's buffer, and surface
 * them in Mission Control via `GET /api/admin/render-deploy-health`.
 *
 * Why a per-role key (no multi-writer race)
 * ─────────────────────────────────────────
 * The cache backend (memoryCache + Postgres) doesn't have a CAS or
 * append primitive — `cache.set` is last-write-wins. Each role writes
 * to its own key (`process:fatals:api`, `process:fatals:worker`,
 * `process:fatals:all`), so there is at most one writer per key in any
 * given deployment topology. Race-free without a lock.
 *
 * Bounding
 * ────────
 *   - Cap: BUFFER_CAP entries (oldest dropped).
 *   - TTL: BUFFER_TTL_MS (so stale fatals from yesterday don't pollute
 *     today's view; the operator wants "what's burning right now").
 */

import { cache } from "./cache";

const BUFFER_CAP = 10;
const BUFFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface FatalEntry {
  ts: number;          // epoch ms
  role: string;        // RUN_MODE: "api" | "worker" | "all"
  pid: number;
  msg: string;         // the message string passed to logger.fatal
  err?: string;        // err.message if a bound `err` field was present
  stack?: string;      // err.stack truncated to keep cache rows small
}

function bufferKey(role: string): string {
  return `process:fatals:${role}`;
}

/**
 * Append a fatal entry to this process's role-buffer in cache.
 * Read-modify-write — single writer per key, so no race.
 * Best-effort: never throws (we don't want logging itself to crash).
 */
async function appendFatal(entry: FatalEntry): Promise<void> {
  try {
    const key = bufferKey(entry.role);
    const existing = (await cache.get<FatalEntry[]>(key)) ?? [];
    const next = [...existing, entry].slice(-BUFFER_CAP);
    await cache.set(key, next, BUFFER_TTL_MS);
  } catch {
    // Swallow — logging path must never throw. Sentry already gets the
    // original fatal via its own breadcrumb hook.
  }
}

/**
 * The pino-wrapping recorder. Installed by `installFatalLogBuffer()`
 * and called by the wrapped `logger.fatal` after the original fires.
 *
 * Pino's `.fatal()` accepts these overloads:
 *   - fatal(msg: string)
 *   - fatal(obj: object, msg?: string)
 *   - fatal(obj: object, msg: string, ...interpolationValues)
 *
 * We extract a useful `{msg, err, stack}` from any of them.
 */
export function extractFatalEntry(args: unknown[]): FatalEntry {
  let msg = "";
  let err: string | undefined;
  let stack: string | undefined;

  if (args.length === 0) {
    msg = "(empty fatal log call)";
  } else if (typeof args[0] === "string") {
    msg = args[0];
  } else if (args[0] && typeof args[0] === "object") {
    const obj = args[0] as Record<string, unknown>;
    msg = typeof args[1] === "string" ? args[1] : "(no message)";
    const boundErr = obj.err ?? obj.error;
    if (boundErr instanceof Error) {
      err = boundErr.message;
      stack = boundErr.stack?.slice(0, 2000);
    } else if (typeof boundErr === "string") {
      err = boundErr;
    } else if (boundErr && typeof boundErr === "object") {
      const maybeMsg = (boundErr as { message?: unknown }).message;
      if (typeof maybeMsg === "string") err = maybeMsg;
    }
  } else {
    msg = String(args[0]);
  }

  return {
    ts: Date.now(),
    role: (process.env.RUN_MODE ?? "all").toLowerCase(),
    pid: process.pid,
    msg: msg.slice(0, 1000), // bound row size
    err: err?.slice(0, 1000),
    stack,
  };
}

/**
 * Read the recent fatals from ALL known role buffers (api, worker, all),
 * merged and sorted newest-first. Used by the admin endpoint.
 *
 * In RUN_MODE=all (single-process dev) only the `all` buffer exists;
 * in production-split (api + worker services) only `api` and `worker`
 * buffers exist. Reading all three covers both deployment topologies
 * without the caller needing to know which is in use.
 */
export async function readAllRoleFatals(): Promise<FatalEntry[]> {
  const roles = ["api", "worker", "all"];
  const lists = await Promise.all(
    roles.map((r) => cache.get<FatalEntry[]>(bufferKey(r))),
  );
  const merged: FatalEntry[] = [];
  for (const list of lists) {
    if (Array.isArray(list)) merged.push(...list);
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, BUFFER_CAP);
}

/**
 * Wires the cache-write side effect into `logger.fatal`. Called once
 * from the boot path AFTER the cache module has finished initialising
 * (the dynamic import inside is just defensive — `cache` is module-
 * level here, so it's already loaded by the time this runs).
 */
let _appender: ((entry: FatalEntry) => void) | null = null;
export function installFatalAppender(): void {
  _appender = (entry) => {
    void appendFatal(entry);
  };
}
export function getFatalAppender(): ((entry: FatalEntry) => void) | null {
  return _appender;
}
