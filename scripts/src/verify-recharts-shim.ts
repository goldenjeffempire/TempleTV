#!/usr/bin/env node
// scripts/src/verify-recharts-shim.ts
//
// Hard guardrail: any file under artifacts/admin/src/ that imports from
// "recharts" directly (instead of going through "@/lib/recharts-shim") will
// fail this check with a clear remediation message.
//
// Why this exists:
//   recharts 2.x ships class-component types that don't satisfy React 19's
//   strict JSX checker shape. The mismatch is environment-sensitive — pnpm's
//   hoisting under different install conditions sometimes hides it (so it
//   passes locally) and sometimes exposes it (so it breaks on Render). The
//   recharts-shim file casts the affected components to ComponentType<any>
//   so JSX usage is always satisfied regardless of the install order.
//
//   Without this gate, a future page or component can innocently
//   `import { LineChart } from "recharts"` directly, pass typecheck on the
//   developer's machine, and then break a Render deploy with the same
//   "JSX element class does not support attributes" / "cannot be used as a
//   JSX component" errors that just blocked us in 2 separate deploy rounds.
//
//   The single allowed direct-importer is the shim file itself.
//
// Wired into root `verify` and `verify:production` scripts. Runs in <100ms
// (pure file walk + per-file regex), so it's free to run on every commit.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const SCAN_ROOT = join(REPO_ROOT, "artifacts", "admin", "src");
const SHIM_RELATIVE = join("artifacts", "admin", "src", "lib", "recharts-shim.ts");
const SHIM_ABSOLUTE = resolve(REPO_ROOT, SHIM_RELATIVE);

// Matches `from "recharts"`, `from 'recharts'`, `from "recharts/some/path"`.
// Does NOT match `from "@/lib/recharts-shim"` etc.
const RECHARTS_IMPORT = /\bfrom\s+["']recharts(?:\/[^"']+)?["']/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "build") continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walk(full);
    } else if (/\.(tsx?|mtsx?|ctsx?)$/.test(name)) {
      yield full;
    }
  }
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(SCAN_ROOT)) {
    if (resolve(file) === SHIM_ABSOLUTE) continue;
    const text = readFileSync(file, "utf8");
    if (!RECHARTS_IMPORT.test(text)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (RECHARTS_IMPORT.test(lines[i])) {
        violations.push({
          file: relative(REPO_ROOT, file),
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }
  }
  return violations;
}

const violations = scan();
if (violations.length === 0) {
  process.stdout.write(
    `[verify:recharts-shim] OK — no direct recharts imports in artifacts/admin/src/ (only ${SHIM_RELATIVE} may import recharts directly).\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `\n[verify:recharts-shim] FAIL — ${violations.length} file(s) import recharts directly:\n\n`,
);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.text}\n`);
}
process.stderr.write(
  `\n  Why this is blocked:\n` +
    `    recharts 2.x has React 19 JSX-strictness compatibility issues that pnpm's\n` +
    `    hoisting under Render's install conditions exposes (but local installs\n` +
    `    sometimes hide). Direct imports cause Render-only TS2786/TS2607 failures.\n\n` +
    `  How to fix:\n` +
    `    Replace 'from "recharts"' with 'from "@/lib/recharts-shim"' in the file(s)\n` +
    `    above. If the shim doesn't yet export the component you need, add it to\n` +
    `    ${SHIM_RELATIVE}\n` +
    `    using the same 'as unknown as ComponentType<any>' cast pattern.\n\n` +
    `  Background: see top of replit.md for the recharts-shim entries.\n`,
);
process.exit(1);
