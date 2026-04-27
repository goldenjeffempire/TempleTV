#!/usr/bin/env node
// scripts/src/run-typechecks.ts
//
// Sequential typecheck runner for all artifact packages plus the scripts
// package. Bypasses pnpm's --reporter / --stream machinery entirely by using
// child_process.spawn with stdio piped explicitly into BOTH the parent
// stdout/stderr (real-time visibility) AND a per-package log file under
// dist/typecheck-logs/<pkg>.log (durable artifact).
//
// History (April 2026): Render's build environment empirically swallowed
// per-package output from `pnpm -r run typecheck`, even with
// `--reporter=append-only` and then with `--stream`. That meant when an
// artifact's typecheck failed on Render the actual TypeScript error text
// never reached the build log — only the `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`
// summary did, leaving operators guessing across multiple sessions about
// which of several plausible causes was hitting.
//
// This runner gives a two-layer guarantee:
//
//   Layer 1 — real-time log: each child's stdout/stderr is piped through
//   Node into process.stdout/process.stderr line-by-line. An explicit
//   `==> [run-typechecks] <pkg> typecheck — start` banner is flushed BEFORE
//   each spawn, so even if a child crashes before printing anything, the
//   build log shows which package was being checked at the point of failure.
//   On failure: `==> [run-typechecks] <pkg> typecheck — FAILED (exit N, X.Xs)`
//   is appended after the child's own output so the failing package and
//   the actual error text always sit adjacent in the log.
//
//   Layer 2 — durable file: every byte of every child's stdout+stderr is
//   ALSO appended to dist/typecheck-logs/<pkg>.log (with `@workspace/`
//   stripped from the filename). On Render, the build cwd persists across
//   the build command and the post-build step, so the log files can be
//   uploaded as build artifacts, inspected via shell, or copied into the
//   final image — even if Render's streaming log mechanism swallows the
//   real-time output entirely. On failure, the runner cats the failing
//   package's log file path so operators always know exactly where to look.
//
//   Layer 3 — failure marker: on failure, the runner writes a small JSON
//   marker file at dist/last-failure.txt containing the failing package
//   name, its per-package log file path, exit code/signal, elapsed ms, and
//   an ISO timestamp. Any subsequent step (a Slack notifier, a Render
//   post-build hook, a CI webhook, a developer 1-liner) can `cat` or
//   `jq -r .logPath` this file to get a stable, parseable handle to the
//   failure without grepping multi-thousand-line build output. The marker
//   is unconditionally deleted at the START of every run so a successful
//   re-run never leaves a stale marker behind, and a failed run never sees
//   a previous run's marker.
//
// Pass --include-mockup to also typecheck @workspace/mockup-sandbox (used by
// the local `verify` chain). Production (`verify:production`) omits it
// because mockup-sandbox is a Replit-canvas-only dev preview tool that
// ships in zero of the 5 deployed Render services.

import { spawn } from "node:child_process";
import {
  mkdirSync,
  createWriteStream,
  existsSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const includeMockup = args.includes("--include-mockup");

const ARTIFACTS: readonly string[] = [
  "@workspace/api-server",
  "@workspace/admin",
  "@workspace/tv",
  "@workspace/mobile",
  ...(includeMockup ? ["@workspace/mockup-sandbox"] : []),
  "@workspace/scripts",
];

// Resolve repo root from this file's location: scripts/src/run-typechecks.ts → ../..
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const LOG_DIR = join(REPO_ROOT, "dist", "typecheck-logs");
const FAILURE_MARKER_PATH = join(REPO_ROOT, "dist", "last-failure.txt");

mkdirSync(LOG_DIR, { recursive: true });

// Always start clean: a previous run's marker would mislead any downstream
// step (Slack notifier, post-build hook, etc.) into reporting a stale failure.
if (existsSync(FAILURE_MARKER_PATH)) {
  try {
    unlinkSync(FAILURE_MARKER_PATH);
  } catch {
    // Non-fatal — if we can't unlink, the overwrite below (on failure) or
    // the absence-check (on success) still produces correct semantics.
  }
}

function logFilePathFor(pkg: string): string {
  // "@workspace/api-server" → "api-server.log"
  const safe = pkg.replace(/^@workspace\//, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(LOG_DIR, `${safe}.log`);
}

interface PackageResult {
  pkg: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
  elapsedMs: number;
  logPath: string;
}

function runOne(pkg: string): Promise<PackageResult> {
  const logPath = logFilePathFor(pkg);
  const fileStream = createWriteStream(logPath, { flags: "w" });
  const t0 = Date.now();

  return new Promise<PackageResult>((res) => {
    const child = spawn(
      "pnpm",
      ["--filter", pkg, "--if-present", "run", "typecheck"],
      { stdio: ["inherit", "pipe", "pipe"], env: process.env },
    );

    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      fileStream.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      fileStream.write(chunk);
    });

    child.on("close", (code, signal) => {
      fileStream.end(() => {
        res({
          pkg,
          exitCode: code,
          signal,
          spawnError,
          elapsedMs: Date.now() - t0,
          logPath,
        });
      });
    });
  });
}

async function main() {
  const totalStart = Date.now();
  let failed: PackageResult | null = null;
  const completed: PackageResult[] = [];

  for (const pkg of ARTIFACTS) {
    process.stdout.write(`\n==> [run-typechecks] ${pkg} typecheck — start (log: ${logFilePathFor(pkg)})\n`);
    const result = await runOne(pkg);
    completed.push(result);
    const elapsedSecs = (result.elapsedMs / 1000).toFixed(1);

    if (result.spawnError) {
      process.stdout.write(
        `\n==> [run-typechecks] ${pkg} typecheck — FAILED to spawn: ${result.spawnError.message}\n`,
      );
      failed = result;
      break;
    }
    if (result.signal) {
      process.stdout.write(
        `\n==> [run-typechecks] ${pkg} typecheck — TERMINATED by signal ${result.signal} (${elapsedSecs}s)\n`,
      );
      failed = result;
      break;
    }
    if (typeof result.exitCode === "number" && result.exitCode !== 0) {
      process.stdout.write(
        `\n==> [run-typechecks] ${pkg} typecheck — FAILED (exit ${result.exitCode}, ${elapsedSecs}s)\n`,
      );
      failed = result;
      break;
    }
    process.stdout.write(
      `==> [run-typechecks] ${pkg} typecheck — ok (${elapsedSecs}s)\n`,
    );
  }

  const totalSecs = ((Date.now() - totalStart) / 1000).toFixed(1);

  if (failed) {
    const sizeBytes = existsSync(failed.logPath) ? statSync(failed.logPath).size : 0;
    const marker = {
      pkg: failed.pkg,
      logPath: failed.logPath,
      logSizeBytes: sizeBytes,
      exitCode: failed.exitCode,
      signal: failed.signal,
      elapsedMs: failed.elapsedMs,
      totalElapsedMs: Date.now() - totalStart,
      spawnError: failed.spawnError ? failed.spawnError.message : null,
      timestamp: new Date().toISOString(),
      logDir: LOG_DIR,
    };
    let markerWriteError: string | null = null;
    try {
      writeFileSync(FAILURE_MARKER_PATH, JSON.stringify(marker, null, 2) + "\n", "utf8");
    } catch (err) {
      markerWriteError = err instanceof Error ? err.message : String(err);
    }
    process.stdout.write(
      `\n==> [run-typechecks] FAIL — ${failed.pkg} typecheck failed after ${totalSecs}s total.\n` +
        `==> [run-typechecks] Per-package log captured (${sizeBytes} bytes): ${failed.logPath}\n` +
        `==> [run-typechecks] All package logs: ${LOG_DIR}\n` +
        (markerWriteError
          ? `==> [run-typechecks] WARN — failed to write failure marker (${markerWriteError})\n`
          : `==> [run-typechecks] Failure marker: ${FAILURE_MARKER_PATH} (JSON; downstream steps can read .logPath/.pkg/.exitCode without grep)\n`) +
        `==> [run-typechecks] If the streamed output above was truncated, cat the failing log file for the complete TypeScript error text.\n`,
    );
    process.exit(typeof failed.exitCode === "number" ? failed.exitCode : 1);
  }

  process.stdout.write(
    `\n==> [run-typechecks] OK — all ${ARTIFACTS.length} artifact(s) typechecked clean in ${totalSecs}s\n` +
      `==> [run-typechecks] Per-package logs: ${LOG_DIR}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`\n==> [run-typechecks] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
