#!/usr/bin/env tsx
/**
 * verify:mobile-lockfile
 *
 * Guards against the class of pnpm global-override conflict that causes EAS
 * Android builds to fail with cryptic runtime errors deep inside Gradle tasks
 * (e.g. "TypeError: expand is not a function" at codegen time).
 *
 * ── Background ───────────────────────────────────────────────────────────────
 *
 * pnpm.overrides in the root package.json pins EVERY instance of a package to
 * a given version range, regardless of what individual consumers declared.
 * When an override bumps a package across a major version boundary, any
 * consumer that was written against the old major's API may break at runtime —
 * sometimes silently, sometimes with an obscure stack trace many steps removed
 * from the root cause.
 *
 * Three active global overrides in this repo cross a major boundary:
 *
 *   brace-expansion  >=2.0.3   (was 1.x — v1→v2 renamed the `expand` export)
 *   picomatch        >=4.0.4   (was 2.x — v2→v4 changed pattern-parsing APIs)
 *   path-to-regexp   >=8.4.0   (was 0.x/6.x — v8 rewrote the entire API)
 *
 * ── What this script checks ──────────────────────────────────────────────────
 *
 * The script runs a table of DEPENDENCY RESOLUTION CHECKS. Each check covers
 * one consumer → dependency pair and asserts that the resolved version in
 * pnpm-lock.yaml snapshots is on an expected major. Two severities:
 *
 *   FAIL  The mismatch is a proven build-breaker with no safe fallback.
 *         A scoped override is required and the check enforces its presence.
 *
 *   WARN  The mismatch is an undocumented cross-major deviation that currently
 *         works at runtime. It is recorded so future picomatch/minimatch bumps
 *         are caught before they silently break. A scoped override is optional;
 *         the check documents any resolved major outside the known-safe list.
 *
 * ── The check table ──────────────────────────────────────────────────────────
 *
 *  #  Consumer         Dep              Req.  Severity  Scoped override key
 *  ─  ───────────────  ───────────────  ────  ────────  ──────────────────────────────
 *  1  minimatch@3.x    brace-expansion   1    FAIL      minimatch@3>brace-expansion
 *  2  glob@7.x         minimatch         3    FAIL      (none — forward guard only)
 *  3  micromatch@4.x   picomatch         2    WARN      micromatch@4>picomatch (if ever needed)
 *  4  anymatch@3.x     picomatch         2    WARN      anymatch@3>picomatch   (if ever needed)
 *
 * Check 1 — FAIL  (original 2026-05-03 production incident)
 *   brace-expansion >=2.0.3 forces minimatch@3.x onto v2, whose API differs:
 *   `expand` is no longer a named export → `expand is not a function` at the
 *   Codegen step → Gradle BUILD FAILED. Fix: scoped override
 *   "minimatch@3>brace-expansion": "^1.1.11" restores the v1 API for minimatch@3.
 *
 * Check 2 — FAIL  (forward guard)
 *   glob@7 depends on minimatch@^3 (check 1's chain). If someone adds a global
 *   minimatch override (e.g. "minimatch: >=9.0.0"), glob@7 would get minimatch@9,
 *   check 1 would silently disappear (no minimatch@3 snapshots remain), and the
 *   codegen chain would break in a new way. This check catches that regression
 *   by asserting glob@7.x always resolves minimatch to major 3.
 *
 * Check 3 & 4 — WARN  (known cross-major deviations)
 *   micromatch@4 declared picomatch@^2.3.1; anymatch@3 declared picomatch@^2.0.0.
 *   Both get picomatch@4.0.4 due to the global override. Metro bundling succeeds
 *   (the JavaScript bundle step in EAS logs), confirming picomatch@4 is backward-
 *   compatible with how micromatch@4 and anymatch@3 call it. Recorded here so any
 *   future picomatch major bump is detected immediately — before the next EAS build.
 *   If a new picomatch version breaks micromatch/anymatch, add the corresponding
 *   scoped override and move severity to FAIL.
 *
 * ── How to fix failures ──────────────────────────────────────────────────────
 *
 *   FAIL — scoped override missing or wrong:
 *     Add or correct the scoped override key in the root package.json
 *     pnpm.overrides, then run `pnpm install` to regenerate the lockfile.
 *
 *   FAIL — lockfile snapshot wrong:
 *     The scoped override exists in package.json but the lockfile was not
 *     regenerated after it was added. Run `pnpm install`.
 *
 *   WARN — new unknown major:
 *     A global override has bumped the dep to an untested major. Verify the
 *     consumer still works, then either add a scoped override + move to FAIL
 *     severity, or add the new major to the `knownSafeMajors` list below.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const LOCKFILE_PATH = resolve(ROOT, "pnpm-lock.yaml");
const PKG_PATH = resolve(ROOT, "package.json");
const TAG = "[verify:mobile-lockfile]";

// ─────────────────────────────────────────────────────────────────────────────
// Check table
// ─────────────────────────────────────────────────────────────────────────────

interface Check {
  /** Human-readable label used in messages. */
  label: string;
  /** Matches snapshot package keys (e.g. /^minimatch@3\./) */
  consumerPattern: RegExp;
  /** The dependency name to inspect inside matching snapshots. */
  dep: string;
  /** The major version the consumer requires. Used in error messages. */
  requiredMajor: number;
  /**
   * "fail" → a scoped override is REQUIRED; the check enforces both the
   *           package.json entry and the lockfile resolved version.
   * "warn" → the cross-major deviation is currently known-safe; only the
   *           lockfile resolved version is checked, and only against
   *           `knownSafeMajors`.
   */
  severity: "fail" | "warn";
  /**
   * For FAIL checks: the key that MUST exist in pnpm.overrides (e.g.
   * "minimatch@3>brace-expansion") with a value targeting `requiredMajor`.
   * Null when no scoped override is required (forward-guard-only checks).
   */
  scopedOverrideKey: string | null;
  /**
   * The global override key that creates the conflict (e.g. "brace-expansion").
   * Used in error messages to explain causation. Null for forward guards where
   * no global override currently exists but the check protects against one
   * being added in the future.
   */
  globalOverrideKey: string | null;
  /**
   * For WARN checks: resolved majors that are tested and known to work at
   * runtime. If the resolved major is in this list the check is informational
   * only. If a new unknown major appears, it is flagged as a warning.
   * Unused for FAIL checks (where any wrong major is an error).
   */
  knownSafeMajors: number[];
  /** Brief explanation of the API incompatibility risk. */
  why: string;
}

const CHECKS: Check[] = [
  {
    label: "minimatch@3 → brace-expansion must be 1.x",
    consumerPattern: /^minimatch@3\./,
    dep: "brace-expansion",
    requiredMajor: 1,
    severity: "fail",
    scopedOverrideKey: "minimatch@3>brace-expansion",
    globalOverrideKey: "brace-expansion",
    knownSafeMajors: [],
    why:
      'brace-expansion v2 removed the named `expand` export that minimatch@3 ' +
      "calls directly. Without the scoped override, the global brace-expansion " +
      ">=2.0.3 override forces minimatch@3 onto v2, causing:\n" +
      "    TypeError: expand is not a function (minimatch.js:271)\n" +
      "  in the :react-native-*:generateCodegenSchemaFromJavaScript Gradle tasks.",
  },
  {
    label: "glob@7 → minimatch must be 3.x",
    consumerPattern: /^glob@7\./,
    dep: "minimatch",
    requiredMajor: 3,
    severity: "fail",
    scopedOverrideKey: null,
    globalOverrideKey: null,
    knownSafeMajors: [],
    why:
      "glob@7 depends on minimatch@^3 (check 1's chain root). If a global " +
      '"minimatch" override is ever added (e.g. "minimatch: >=9.0.0"), glob@7 ' +
      "would silently receive minimatch@9, the minimatch@3 snapshots would " +
      "disappear from the lockfile, and the Codegen failure would reappear in " +
      "a new form. This forward guard catches that regression before EAS build.",
  },
  {
    label: "micromatch@4 → picomatch cross-major check",
    consumerPattern: /^micromatch@4\./,
    dep: "picomatch",
    requiredMajor: 2,
    severity: "warn",
    scopedOverrideKey: "micromatch@4>picomatch",
    globalOverrideKey: "picomatch",
    knownSafeMajors: [4],
    why:
      "micromatch@4 declared picomatch@^2.3.1 but gets picomatch@4.0.4 via the " +
      "global picomatch >=4.0.4 override. Metro bundling confirms picomatch@4 is " +
      "backward-compatible with micromatch@4's usage pattern. Tracked here so a " +
      "future picomatch major bump is caught before file-watching / Metro breaks.",
  },
  {
    label: "anymatch@3 → picomatch cross-major check",
    consumerPattern: /^anymatch@3\./,
    dep: "picomatch",
    requiredMajor: 2,
    severity: "warn",
    scopedOverrideKey: "anymatch@3>picomatch",
    globalOverrideKey: "picomatch",
    knownSafeMajors: [4],
    why:
      "anymatch@3 declared picomatch@^2.0.0 but gets picomatch@4.0.4 via the " +
      "global picomatch >=4.0.4 override. chokidar (file watching) uses anymatch " +
      "internally; Metro startup confirms this is currently safe. Tracked here so " +
      "a future picomatch bump is caught before chokidar-based watching breaks.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseMajor(version: string): number | null {
  const m = version.match(/^(\d+)[.-]/);
  if (!m) {
    const bare = version.match(/^(\d+)$/);
    return bare ? parseInt(bare[1], 10) : null;
  }
  return parseInt(m[1], 10);
}

/** Returns true if `spec` targets only the given major. */
function specTargetsMajor(spec: string, major: number): boolean {
  const s = spec.trim();
  const M = major;
  // Bare: 1, 1.x, 1.X, 1.*
  if (new RegExp(`^${M}(\\.([xX*](\\.([xX*]))?)?)?$`).test(s)) return true;
  // Caret: ^M.y.z
  if (new RegExp(`^\\^${M}\\.`).test(s)) return true;
  // Tilde: ~M.y.z
  if (new RegExp(`^~${M}\\.`).test(s)) return true;
  // Range: >=M.y <(M+1).0
  if (new RegExp(`^>=${M}\\.\\d`).test(s) && new RegExp(`<${M + 1}\\.`).test(s))
    {return true;}
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lockfile parser — snapshots section only
//
// Scans for snapshot keys matching `consumerPattern` and extracts the resolved
// version of `dep` from the `dependencies:` block that follows.
//
// The pnpm lockfile has BOTH a `packages:` section (resolution hashes, no dep
// tree) and a `snapshots:` section (resolved dep tree). We must only read
// snapshots — the packages section has no dependency versions listed, so any
// scan of the full file would hit the packages entry first and find nothing.
// ─────────────────────────────────────────────────────────────────────────────

interface SnapshotResult {
  consumerKey: string;
  resolvedVersion: string | null;
}

function findSnapshots(
  lockfileText: string,
  consumerPattern: RegExp,
  dep: string,
): SnapshotResult[] {
  const results: SnapshotResult[] = [];

  // Slice to snapshots section only.
  const idx = lockfileText.indexOf("\nsnapshots:\n");
  const text = idx >= 0 ? lockfileText.slice(idx) : lockfileText;
  const lines = text.split("\n");

  // Escape dep name for use inside a regex (handles scoped packages like
  // @foo/bar which contain special chars).
  const depEscaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const depRe = new RegExp(`^\\s+${depEscaped}:\\s*(\\S+)`);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Snapshot header: 2-space indent, ends with `:`
    // Format: `  packageName@version:` or `  packageName@version(peer@x.y.z):`
    const headerMatch = line.match(/^ {2}(\S+):$/);
    if (!headerMatch) {
      i++;
      continue;
    }

    const consumerKey = headerMatch[1];
    if (!consumerPattern.test(consumerKey)) {
      i++;
      continue;
    }

    // Scan the block that follows until the next same-level key or section.
    let resolvedVersion: string | null = null;
    let j = i + 1;
    while (j < lines.length) {
      const inner = lines[j];
      if (inner.trim() === "") {
        j++;
        continue;
      }
      // Next top-level or 2-space key → end of this snapshot's block.
      if (/^\S/.test(inner) || /^ {2}\S/.test(inner)) break;

      const depMatch = inner.match(depRe);
      if (depMatch) {
        resolvedVersion = depMatch[1];
        break;
      }
      j++;
    }

    results.push({ consumerKey, resolvedVersion });
    i++;
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load inputs
// ─────────────────────────────────────────────────────────────────────────────

if (!existsSync(PKG_PATH)) {
  console.error(`${TAG} FAIL — root package.json not found at ${PKG_PATH}`);
  process.exit(1);
}
if (!existsSync(LOCKFILE_PATH)) {
  console.error(
    `${TAG} FAIL — pnpm-lock.yaml not found at ${LOCKFILE_PATH} — run \`pnpm install\` first.`,
  );
  process.exit(1);
}

const rootPkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
  pnpm?: { overrides?: Record<string, string> };
};
const overrides: Record<string, string> = rootPkg.pnpm?.overrides ?? {};
const lockfileText = readFileSync(LOCKFILE_PATH, "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// Run checks
// ─────────────────────────────────────────────────────────────────────────────

const failures: string[] = [];
const warnings: string[] = [];
const ok: string[] = [];
const fail = (msg: string) => failures.push(msg);
const warn = (msg: string) => warnings.push(msg);

for (const check of CHECKS) {
  const snapshots = findSnapshots(lockfileText, check.consumerPattern, check.dep);

  // ── a) Scoped override presence (FAIL checks only) ────────────────────────
  if (check.severity === "fail" && check.scopedOverrideKey !== null) {
    const overrideValue = overrides[check.scopedOverrideKey];
    if (overrideValue === undefined) {
      fail(
        `[${check.label}] Missing scoped override "${check.scopedOverrideKey}" in\n` +
          `  root package.json pnpm.overrides.\n\n` +
          `  ${check.why}\n\n` +
          `  Fix: add to pnpm.overrides:\n` +
          `    "${check.scopedOverrideKey}": "^${check.requiredMajor}.0.0"\n` +
          `  (use the minimum compatible patch, e.g. "^${check.requiredMajor}.1.11")\n` +
          `  Then run \`pnpm install\` to regenerate the lockfile.`,
      );
    } else if (!specTargetsMajor(overrideValue, check.requiredMajor)) {
      fail(
        `[${check.label}] Scoped override "${check.scopedOverrideKey}" is "${overrideValue}"\n` +
          `  which does NOT target major ${check.requiredMajor}.x.\n\n` +
          `  ${check.why}\n\n` +
          `  Fix: change the value to "^${check.requiredMajor}.1.11" (or any ${check.requiredMajor}.x range),\n` +
          `  then run \`pnpm install\`.`,
      );
    }
  }

  // ── b) Lockfile snapshot verification ─────────────────────────────────────
  if (snapshots.length === 0) {
    // No matching snapshots — could mean the package was removed, or the
    // consumer pattern needs updating. Warn so it doesn't silently atrophy.
    warn(
      `[${check.label}] No "${check.consumerPattern.source}" snapshots found in\n` +
        `  pnpm-lock.yaml. Either the package was removed from the dependency tree\n` +
        `  (in which case this check entry should be retired) or the pattern no\n` +
        `  longer matches (update consumerPattern in the check table).`,
    );
    continue;
  }

  for (const { consumerKey, resolvedVersion } of snapshots) {
    if (resolvedVersion === null) {
      if (check.severity === "fail") {
        fail(
          `[${check.label}] Snapshot "${consumerKey}" has no "${check.dep}"\n` +
            `  dependency in pnpm-lock.yaml. This is unexpected — the lockfile may\n` +
            `  be stale. Run \`pnpm install\` to regenerate it.`,
        );
      } else {
        warn(
          `[${check.label}] Snapshot "${consumerKey}" has no "${check.dep}" dep listed.\n` +
            `  The package may declare it as optional or peer-only. If intentional,\n` +
            `  narrow the consumerPattern or remove the entry from the check table.`,
        );
      }
      continue;
    }

    const resolvedMajor = parseMajor(resolvedVersion);

    if (check.severity === "fail") {
      if (resolvedMajor !== check.requiredMajor) {
        const globalNote = check.globalOverrideKey
          ? `The global override "${check.globalOverrideKey}" in pnpm.overrides is\n` +
            `  forcing ${check.dep} to ${resolvedVersion} (major ${resolvedMajor ?? "?"}). `
          : `A global pnpm override is forcing ${check.dep} to ${resolvedVersion}. `;
        fail(
          `[${check.label}] Snapshot "${consumerKey}" resolves\n` +
            `  ${check.dep} to ${resolvedVersion} (major ${resolvedMajor ?? "?"}), but major ${check.requiredMajor} is required.\n\n` +
            `  ${globalNote}\n` +
            `  ${check.why}\n\n` +
            `  Fix: ensure the scoped override exists in package.json, then run\n` +
            `  \`pnpm install\` to regenerate the lockfile.`,
        );
      } else {
        ok.push(
          `${consumerKey} → ${check.dep}@${resolvedVersion} ✓ (major ${resolvedMajor})`,
        );
      }
    } else {
      // WARN check — report any major not in knownSafeMajors
      if (
        resolvedMajor !== check.requiredMajor &&
        (resolvedMajor === null || !check.knownSafeMajors.includes(resolvedMajor))
      ) {
        warn(
          `[${check.label}] Snapshot "${consumerKey}" resolves\n` +
            `  ${check.dep} to ${resolvedVersion} (major ${resolvedMajor ?? "?"}), outside known-safe\n` +
            `  majors [${check.knownSafeMajors.join(", ")}] and required major ${check.requiredMajor}.\n\n` +
            `  ${check.why}\n\n` +
            `  Action: verify the consumer still works, then either:\n` +
            `    (a) Add a scoped override "${check.scopedOverrideKey ?? `${check.consumerPattern.source}>${check.dep}`}": "^${check.requiredMajor}.0.0"\n` +
            `        and change severity to "fail" in the check table, OR\n` +
            `    (b) Add ${resolvedMajor} to knownSafeMajors in the check table entry.`,
        );
      } else {
        const note =
          resolvedMajor === check.requiredMajor
            ? `on required major ${check.requiredMajor}`
            : `on known-safe major ${resolvedMajor} (declared ^${check.requiredMajor}, known-safe: [${check.knownSafeMajors.join(", ")}])`;
        ok.push(`${consumerKey} → ${check.dep}@${resolvedVersion} ✓ (${note})`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

for (const w of warnings) {
  console.warn(`${TAG} WARN — ${w}\n`);
}

if (failures.length > 0) {
  console.error(`\n${TAG} FAIL — ${failures.length} check(s) failed:\n`);
  for (let i = 0; i < failures.length; i++) {
    console.error(`  ${i + 1}. ${failures[i]}\n`);
  }
  process.exit(1);
}

const warnSuffix =
  warnings.length > 0
    ? ` (${warnings.length} informational warning(s) — see above)`
    : "";
console.log(
  `${TAG} OK — ${CHECKS.length} checks, ${ok.length} snapshot(s) verified:${warnSuffix}\n` +
    ok.map((s) => `  • ${s}`).join("\n"),
);
