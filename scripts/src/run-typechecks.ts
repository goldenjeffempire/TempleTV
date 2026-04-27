#!/usr/bin/env node
// scripts/src/run-typechecks.ts
//
// Sequential typecheck runner for all artifact packages plus the scripts
// package. Bypasses pnpm's --reporter / --stream machinery entirely by using
// child_process.spawnSync with stdio:'inherit', which inherits the parent's
// file descriptors at the OS level.
//
// History (April 2026): Render's build environment empirically swallowed
// per-package output from `pnpm -r run typecheck`, even with
// `--reporter=append-only` and then with `--stream`. That meant when an
// artifact's typecheck failed on Render the actual TypeScript error text
// never reached the build log — only the `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`
// summary did, leaving operators guessing across multiple sessions about
// which of several plausible causes was hitting. By spawning each child with
// stdio:'inherit', this runner guarantees that:
//   1. tsc's stdout/stderr lines reach the parent log immediately (kernel
//      pipe — no Node-side buffering, no pnpm reporter in the way),
//   2. an explicit `==> [run-typechecks] <pkg> typecheck — start` banner is
//      flushed BEFORE each spawn, so even if a child crashes before
//      printing anything, the build log clearly shows which package was
//      being checked at the point of failure,
//   3. on failure, an explicit FAIL marker with elapsed time and exit code
//      is appended after the child's own output so the failing package and
//      the actual error text always sit adjacent in the log.
//
// Pass --include-mockup to also typecheck @workspace/mockup-sandbox (used by
// the local `verify` chain). Production (`verify:production`) omits it
// because mockup-sandbox is a Replit-canvas-only dev preview tool that ships
// in zero of the 5 deployed Render services and should never block a deploy.

import { spawnSync } from "node:child_process";

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

const totalStart = Date.now();
let failed: { pkg: string; status: number | null; signal: NodeJS.Signals | null } | null = null;

for (const pkg of ARTIFACTS) {
  process.stdout.write(`\n==> [run-typechecks] ${pkg} typecheck — start\n`);
  const t0 = Date.now();
  const result = spawnSync(
    "pnpm",
    ["--filter", pkg, "--if-present", "run", "typecheck"],
    { stdio: "inherit", env: process.env },
  );
  const elapsedSecs = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.error) {
    process.stdout.write(
      `\n==> [run-typechecks] ${pkg} typecheck — FAILED to spawn: ${result.error.message}\n`,
    );
    failed = { pkg, status: null, signal: null };
    break;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.stdout.write(
      `\n==> [run-typechecks] ${pkg} typecheck — FAILED (exit ${result.status}, ${elapsedSecs}s)\n`,
    );
    failed = { pkg, status: result.status, signal: result.signal };
    break;
  }
  if (result.signal) {
    process.stdout.write(
      `\n==> [run-typechecks] ${pkg} typecheck — TERMINATED by signal ${result.signal} (${elapsedSecs}s)\n`,
    );
    failed = { pkg, status: null, signal: result.signal };
    break;
  }
  process.stdout.write(
    `==> [run-typechecks] ${pkg} typecheck — ok (${elapsedSecs}s)\n`,
  );
}

const totalSecs = ((Date.now() - totalStart) / 1000).toFixed(1);

if (failed) {
  process.stdout.write(
    `\n==> [run-typechecks] FAIL — ${failed.pkg} typecheck failed after ${totalSecs}s total. See per-package output above for the actual TypeScript error(s).\n`,
  );
  process.exit(typeof failed.status === "number" ? failed.status : 1);
}

process.stdout.write(
  `\n==> [run-typechecks] OK — all ${ARTIFACTS.length} artifact(s) typechecked clean in ${totalSecs}s\n`,
);
