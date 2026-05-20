/**
 * verify-metro-paths
 * ─────────────────────────────────────────────────────────────────────────────
 * Statically parses artifacts/mobile/metro.config.js and verifies that every
 * workspace path referenced in watchFolders and extraNodeModules actually
 * exists on disk.
 *
 * This prevents the class of production build failure where a workspace
 * package is deleted (e.g. lib/streaming-core) but its path string lingers in
 * the Metro config. Metro calls fs.statSync on every watchFolder at startup
 * and throws ENOENT before a single module is bundled, failing the entire
 * `expo export` step silently.
 *
 * Run via: pnpm run verify:metro-paths
 *
 * Exits 0 on success, 1 on any FAIL.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "../../");

type Status = "PASS" | "FAIL" | "WARN";

interface Result {
  status: Status;
  name: string;
  detail?: string;
}

// ── Parse metro.config.js ─────────────────────────────────────────────────────

const METRO_CONFIG = path.join(ROOT, "artifacts/mobile/metro.config.js");

function readMetroConfig(): string {
  if (!fs.existsSync(METRO_CONFIG)) {
    return "";
  }
  return fs.readFileSync(METRO_CONFIG, "utf8");
}

/**
 * Extract all path.join(workspaceRoot, "<relPath>") arguments from the config
 * source. Returns the relative path strings (e.g. "lib/player-core").
 */
function extractWorkspacePaths(source: string): string[] {
  const paths: string[] = [];
  // Matches: path.join(workspaceRoot, "lib/some-package")
  //      or: path.join(workspaceRoot, 'lib/some-package')
  const re = /path\.join\s*\(\s*workspaceRoot\s*,\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    paths.push(m[1]);
  }
  return [...new Set(paths)];
}

// ── Checks ────────────────────────────────────────────────────────────────────

function checkConfigExists(): Result {
  const exists = fs.existsSync(METRO_CONFIG);
  return {
    status: exists ? "PASS" : "FAIL",
    name: "metro.config.js exists",
    detail: exists ? undefined : `Not found at ${METRO_CONFIG}`,
  };
}

function checkAllPathsExist(): Result[] {
  const source = readMetroConfig();
  if (!source) {
    return [
      {
        status: "FAIL",
        name: "metro.config.js readable",
        detail: "File missing or empty",
      },
    ];
  }

  const relPaths = extractWorkspacePaths(source);
  if (relPaths.length === 0) {
    return [
      {
        status: "WARN",
        name: "metro.config.js workspace paths",
        detail:
          "No path.join(workspaceRoot, ...) entries found — config format may have changed",
      },
    ];
  }

  return relPaths.map((rel) => {
    const abs = path.join(ROOT, rel);
    const exists = fs.existsSync(abs);
    return {
      status: (exists ? "PASS" : "FAIL") as Status,
      name: `Path exists: ${rel}`,
      detail: exists ? undefined : `Missing on disk: ${abs}`,
    };
  });
}

// ── Runner ────────────────────────────────────────────────────────────────────

const checks: Result[] = [checkConfigExists(), ...checkAllPathsExist()];

const separator = "─".repeat(60);
console.log(separator);
console.log("  verify:metro-paths — Metro workspace path audit");
console.log(separator);

let failCount = 0;
let warnCount = 0;

for (const r of checks) {
  const icon = r.status === "PASS" ? "✓" : r.status === "WARN" ? "⚠" : "✗";
  const label = r.status === "PASS" ? "PASS" : r.status === "WARN" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${label} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  if (r.status === "FAIL") failCount++;
  if (r.status === "WARN") warnCount++;
}

console.log(separator);
console.log(
  `  ${checks.length} checked, ${warnCount} warning(s), ${failCount} failed`
);
console.log();

if (failCount > 0) {
  console.error(
    "  FAIL — One or more Metro workspace paths do not exist on disk.\n" +
      "  Remove the stale entries from artifacts/mobile/metro.config.js\n" +
      "  (watchFolders and extraNodeModules) before deploying."
  );
  process.exit(1);
}
