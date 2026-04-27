/**
 * Synchronous exit-reason instrumentation.
 *
 * Why this exists
 * ───────────────
 * Production Render logs (2026-04-27) showed the API process disappearing
 * every ~30–60 s with NO shutdown log line — no `Graceful shutdown
 * initiated`, no `Server closed cleanly`, no `Forced shutdown after
 * timeout`, no `uncaught exception`. The supervisor simply re-ran
 * `pnpm start` and a fresh PID showed up. Three of these in 100 s, same
 * pod hostname.
 *
 * That pattern means one of:
 *   1. SIGKILL from the kernel (OOM-killer or platform-initiated)
 *   2. SIGTERM that the handler logged but pino's async transport thread
 *      lost the line during the 15 s force-shutdown timer
 *   3. A `process.exit()` from somewhere unexpected during boot
 *   4. The container being terminated by Render for a platform reason
 *
 * In ALL of those cases, the existing pino logger fails us:
 *   - In production we use the default pino sync stdout writer (no
 *     `transport`), so #2 above isn't strictly the bottleneck —
 *   - HOWEVER pino still buffers via `process.stdout.write` which goes
 *     through Node's internal write queue. A SIGKILL between the
 *     `logger.info(...)` call and the kernel actually flushing the FD
 *     loses the line. SIGTERM gives us up to 30 s on Render so async
 *     pino is fine for that path; SIGKILL gives us zero.
 *
 * This module bypasses pino entirely and writes a single line of JSON
 * directly to `process.stderr.write` — which on Linux is line-buffered
 * to the pipe Render's log collector reads from synchronously. That
 * gives us the BEST POSSIBLE chance of the line surfacing in the
 * dashboard before the process dies.
 *
 * What we capture
 * ───────────────
 * Every signal we can reasonably trap (SIGTERM, SIGINT, SIGHUP, SIGQUIT,
 * SIGUSR2), `process.on('exit')` (catches `process.exit(N)` calls and
 * normal event-loop drain), `process.on('beforeExit')` (catches the
 * exact case of "event loop drained, no error, just nothing left to do"
 * — the silent-exit class), `uncaughtException`, `unhandledRejection`,
 * and Node `warning` events. Each one writes a single
 * `{ts, kind, signal, code, reason, uptimeSec, rss, heapUsed, runMode}`
 * line. SIGKILL itself cannot be trapped (kernel guarantee), but every
 * adjacent path we CAN trap is now wired.
 *
 * Memory snapshot included on every exit line — if a future death
 * happens at >85% of plan RAM, that's the OOM tell even without the
 * Render Events tab.
 */

import { logger } from "./logger";

const startedAtMs = Date.now();

interface ExitContext {
  runMode: string;
  pid: number;
}

let exitReasonAlreadyEmitted = false;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KiB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))}MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
}

/**
 * Write a single JSON line directly to stderr, bypassing pino. The line
 * is prefixed with `EXIT_REASON ` so log aggregators can pick it out
 * trivially (`rg '^EXIT_REASON '` against the Render log dump produces
 * a clean death timeline).
 */
function emitExitLine(payload: Record<string, unknown>): void {
  if (exitReasonAlreadyEmitted) return; // first cause wins; later ones are downstream
  exitReasonAlreadyEmitted = true;

  const mem = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - startedAtMs) / 1000);
  const line = `EXIT_REASON ${JSON.stringify({
    ts: new Date().toISOString(),
    uptimeSec,
    rss: mem.rss,
    rssHuman: fmtBytes(mem.rss),
    heapUsed: mem.heapUsed,
    heapUsedHuman: fmtBytes(mem.heapUsed),
    external: mem.external,
    pid: process.pid,
    ...payload,
  })}\n`;

  // process.stderr.write is the most synchronous path Node offers for a
  // file descriptor that's a pipe (which it is under Render/Docker).
  // Best-effort try/catch in case stderr is somehow closed mid-shutdown.
  try {
    process.stderr.write(line);
  } catch {
    /* nothing more we can do */
  }

  // Also push through pino so the structured log stream gets it (with
  // our normal redaction etc.) — but the stderr line above is the
  // primary signal that's guaranteed to flush before any SIGKILL.
  try {
    logger.warn(payload, "exit reason captured");
  } catch {
    /* ignore */
  }
}

export function installExitReasonInstrumentation(ctx: ExitContext): void {
  // ── Signals ──────────────────────────────────────────────────────────────
  // We trap every signal Node lets us (everything except SIGKILL and
  // SIGSTOP, which the kernel reserves). Each handler RECORDS the cause
  // and then RETURNS — it does NOT exit. The existing shutdown() handler
  // in index.ts owns the actual termination flow; we just instrument
  // around it. SIGKILL cannot be trapped — but if we ever see EXIT_REASON
  // missing from a death line, that's now the diagnostic signal "this
  // was SIGKILL or container-level termination, not anything inside the
  // process".
  const signals: NodeJS.Signals[] = [
    "SIGTERM",
    "SIGINT",
    "SIGHUP",
    "SIGQUIT",
    "SIGUSR2",
  ];
  for (const sig of signals) {
    process.on(sig, () => {
      emitExitLine({
        kind: "signal",
        signal: sig,
        runMode: ctx.runMode,
        note:
          sig === "SIGTERM"
            ? "Render rolling deploy or platform termination"
            : sig === "SIGINT"
              ? "Local Ctrl-C / nodemon restart"
              : sig === "SIGHUP"
                ? "Controlling terminal closed (unusual under Render)"
                : sig === "SIGQUIT"
                  ? "Core-dump request (unusual)"
                  : "Heap-snapshot signal",
      });
    });
  }

  // ── beforeExit ───────────────────────────────────────────────────────────
  // Fires when the event loop has nothing left to do — the silent-exit
  // class. The keep-alive interval in index.ts (worker mode) and the
  // ref'd HTTP server (api mode) should make this UNREACHABLE in
  // production. If we ever see this line, it means a regression caused
  // every ref'd handle to drop, which is the exact bug we feared.
  process.on("beforeExit", (code) => {
    emitExitLine({
      kind: "beforeExit",
      code,
      runMode: ctx.runMode,
      note:
        "Event loop drained with no work — a ref'd handle (server, " +
        "keep-alive interval) was missing or unref'd. This is the " +
        "silent-exit class: process will exit cleanly with code 0 " +
        "and Render will show 'Application exited early' with no " +
        "error. If you see this line, that's the bug.",
    });
  });

  // ── exit ─────────────────────────────────────────────────────────────────
  // Last line ever logged. Captures `process.exit(code)` from anywhere
  // in user code OR a clean event-loop drain. Synchronous handlers only —
  // any async work here is a no-op, the process is already terminating.
  process.on("exit", (code) => {
    emitExitLine({
      kind: "exit",
      code,
      runMode: ctx.runMode,
      note:
        code === 0
          ? "Clean exit (code 0). On Render this surfaces as " +
            "'Application exited early while running your code'."
          : `Non-zero exit (code ${code}). Look UP in the log for the ` +
            "uncaughtException / fatal that triggered it.",
    });
  });

  // ── uncaughtException ────────────────────────────────────────────────────
  // The existing handler in index.ts also calls shutdown(). We don't
  // duplicate that — we just record the cause first so the order in
  // logs is exception → reason → graceful-shutdown messages.
  process.on("uncaughtException", (err) => {
    emitExitLine({
      kind: "uncaughtException",
      runMode: ctx.runMode,
      errMessage: err?.message,
      errName: err?.name,
      errStack: err?.stack?.split("\n").slice(0, 12).join("\n"),
    });
  });

  // ── unhandledRejection ───────────────────────────────────────────────────
  // The existing index.ts handler logs but does NOT shutdown — Node's
  // default behaviour since v15 is to crash on unhandled rejections, so
  // we may or may not actually reach `exit` here depending on
  // --unhandled-rejections flag. Either way, record it.
  process.on("unhandledRejection", (reason) => {
    const r = reason as { message?: string; name?: string; stack?: string };
    emitExitLine({
      kind: "unhandledRejection",
      runMode: ctx.runMode,
      reasonMessage: r?.message ?? String(reason),
      reasonName: r?.name,
      reasonStack: r?.stack?.split("\n").slice(0, 12).join("\n"),
    });
  });

  // ── Node warnings (memory leaks, deprecations, max-listeners) ────────────
  // These don't kill the process but they precede most silent deaths by
  // minutes/hours. Surfacing them at WARN through pino (NOT through the
  // emitExitLine flag, which is for terminal events only) gives us the
  // breadcrumb trail.
  process.on("warning", (warn) => {
    logger.warn(
      {
        kind: "node-warning",
        runMode: ctx.runMode,
        name: warn.name,
        message: warn.message,
        stack: warn.stack?.split("\n").slice(0, 8).join("\n"),
      },
      `Node warning: ${warn.name}: ${warn.message}`,
    );
  });
}

/**
 * Periodic memory pressure sampler — logs RSS / heap every interval and
 * fires a WARN when RSS crosses the configurable high-water mark. On
 * Render's `standard` plan (2 GiB RAM) we default the warn threshold to
 * 1.5 GiB (75 %) — a 25 % headroom cushion before the OOM-killer fires.
 *
 * The sampler timer is `.unref()`'d so it never holds the event loop
 * open; if everything else drains, the process exits cleanly and the
 * sampler dies with it (which is what we want).
 *
 * Returns the timer handle so callers can clear it from a shutdown
 * handler if they want to.
 */
export function startMemoryPressureSampler(opts: {
  runMode: string;
  intervalMs?: number;
  warnAtRssBytes?: number;
}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 60_000;
  const warnAtRssBytes = opts.warnAtRssBytes ?? 1_500 * 1024 * 1024;
  let lastWarnAtMs = 0;

  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const isHigh = mem.rss >= warnAtRssBytes;
    const now = Date.now();
    // Always emit a WARN when over threshold (deduped at 5 min) so the
    // operator sees a clear escalation; otherwise emit at INFO every
    // sample for trendability — pino's default level is `info` so this
    // flows naturally without changing levels.
    if (isHigh && now - lastWarnAtMs >= 5 * 60_000) {
      lastWarnAtMs = now;
      logger.warn(
        {
          rss: mem.rss,
          rssHuman: fmtBytes(mem.rss),
          heapUsed: mem.heapUsed,
          heapUsedHuman: fmtBytes(mem.heapUsed),
          external: mem.external,
          warnAtRssBytes,
          warnAtRssHuman: fmtBytes(warnAtRssBytes),
          runMode: opts.runMode,
        },
        `Memory pressure: RSS ${fmtBytes(mem.rss)} >= ` +
          `${fmtBytes(warnAtRssBytes)} threshold. If the process dies ` +
          "shortly after this line, the cause is OOM-kill (kernel " +
          "SIGKILL — uncatchable, no further log will be emitted from " +
          "the dying process). Increase the Render plan or reduce " +
          "in-memory buffer caps.",
      );
    } else {
      logger.info(
        {
          rss: mem.rss,
          rssHuman: fmtBytes(mem.rss),
          heapUsed: mem.heapUsed,
          heapUsedHuman: fmtBytes(mem.heapUsed),
        },
        "memory sample",
      );
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
