/**
 * verify-platform-consistency
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks that all three platform apps (TV, Admin, Mobile) are wired to the
 * shared @workspace/broadcast-types library and haven't locally re-defined
 * type shapes that must stay in sync across platforms.
 *
 * Run via: pnpm run verify:platform-consistency
 *
 * Exits 0 on success, 1 on any FAIL.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "../../");

type Status = "PASS" | "FAIL" | "WARN";

interface Check {
  name: string;
  run: () => { status: Status; detail?: string };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(relPath: string): Record<string, unknown> {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return {};
  return JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
}

function readText(relPath: string): string {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return "";
  return fs.readFileSync(abs, "utf8");
}

function grepDir(dir: string, pattern: RegExp): { file: string; line: string }[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const results: { file: string; line: string }[] = [];

  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (pattern.test(line)) {
            results.push({ file: path.relative(ROOT, full), line: line.trim() });
          }
        }
      }
    }
  }

  walk(abs);
  return results;
}

function hasDep(pkgPath: string, dep: string): boolean {
  const pkg = readJson(pkgPath);
  const deps = {
    ...(pkg["dependencies"] as Record<string, string> | undefined),
    ...(pkg["devDependencies"] as Record<string, string> | undefined),
  };
  return dep in deps;
}

// ── checks ────────────────────────────────────────────────────────────────────

const SHARED_PKG = "@workspace/broadcast-types";

const CHECKS: Check[] = [
  // ── T001: package declarations ─────────────────────────────────────────────

  {
    name: `TV package.json declares ${SHARED_PKG}`,
    run: () =>
      hasDep("artifacts/tv/package.json", SHARED_PKG)
        ? { status: "PASS" }
        : {
            status: "FAIL",
            detail: `Add "${SHARED_PKG}": "workspace:*" to artifacts/tv/package.json devDependencies`,
          },
  },

  {
    name: `Mobile package.json declares ${SHARED_PKG}`,
    run: () =>
      hasDep("artifacts/mobile/package.json", SHARED_PKG)
        ? { status: "PASS" }
        : {
            status: "FAIL",
            detail: `Add "${SHARED_PKG}": "workspace:*" to artifacts/mobile/package.json devDependencies`,
          },
  },

  {
    name: `Admin package.json declares ${SHARED_PKG}`,
    run: () =>
      hasDep("artifacts/admin/package.json", SHARED_PKG)
        ? { status: "PASS" }
        : {
            status: "WARN",
            detail: `Admin doesn't yet import ${SHARED_PKG}. Add it when Admin consumes broadcast types directly.`,
          },
  },

  // ── T002-T003: actual imports present ──────────────────────────────────────

  {
    name: `TV source imports from ${SHARED_PKG}`,
    run: () => {
      const hits = grepDir("artifacts/tv/src", /from\s+["']@workspace\/broadcast-types["']/);
      return hits.length > 0
        ? { status: "PASS", detail: `${hits.length} import(s) found` }
        : {
            status: "FAIL",
            detail: `No imports from ${SHARED_PKG} found in artifacts/tv/src — check artifacts/tv/src/lib/api.ts and artifacts/tv/src/hooks/useLiveSync.ts`,
          };
    },
  },

  {
    name: `Mobile source imports from ${SHARED_PKG}`,
    run: () => {
      const hits = grepDir("artifacts/mobile", /from\s+["']@workspace\/broadcast-types["']/);
      return hits.length > 0
        ? { status: "PASS", detail: `${hits.length} import(s) found` }
        : {
            status: "FAIL",
            detail: `No imports from ${SHARED_PKG} found in artifacts/mobile — check artifacts/mobile/services/broadcast.ts`,
          };
    },
  },

  // ── T004: no local re-definition of shared types ──────────────────────────

  {
    name: "BroadcastItem not locally defined in TV lib/api.ts",
    run: () => {
      const text = readText("artifacts/tv/src/lib/api.ts");
      const localDef = /^export\s+interface\s+BroadcastItem\b/m.test(text);
      return localDef
        ? {
            status: "FAIL",
            detail:
              "artifacts/tv/src/lib/api.ts still defines BroadcastItem locally — remove it and import from @workspace/broadcast-types",
          }
        : { status: "PASS" };
    },
  },

  {
    name: "BroadcastItem not locally defined in Mobile services/broadcast.ts",
    run: () => {
      const text = readText("artifacts/mobile/services/broadcast.ts");
      const localDef = /^export\s+interface\s+BroadcastItem\b/m.test(text);
      return localDef
        ? {
            status: "FAIL",
            detail:
              "artifacts/mobile/services/broadcast.ts still defines BroadcastItem locally — remove it and import from @workspace/broadcast-types",
          }
        : { status: "PASS" };
    },
  },

  {
    name: "GuideItem not locally defined in TV lib/api.ts",
    run: () => {
      const text = readText("artifacts/tv/src/lib/api.ts");
      const localDef = /^export\s+interface\s+GuideItem\b/m.test(text);
      return localDef
        ? {
            status: "FAIL",
            detail:
              "artifacts/tv/src/lib/api.ts still defines GuideItem locally — remove it and import from @workspace/broadcast-types",
          }
        : { status: "PASS" };
    },
  },

  {
    name: "BroadcastGuideItem not locally defined in Mobile services/broadcast.ts",
    run: () => {
      const text = readText("artifacts/mobile/services/broadcast.ts");
      const localDef = /^export\s+interface\s+BroadcastGuideItem\b/m.test(text);
      return localDef
        ? {
            status: "FAIL",
            detail:
              "artifacts/mobile/services/broadcast.ts still defines BroadcastGuideItem locally — remove it and import from @workspace/broadcast-types",
          }
        : { status: "PASS" };
    },
  },

  {
    name: "BroadcastSyncState not locally defined in TV useLiveSync.ts",
    run: () => {
      const text = readText("artifacts/tv/src/hooks/useLiveSync.ts");
      const localDef = /^export\s+interface\s+BroadcastSyncState\b/m.test(text);
      return localDef
        ? {
            status: "FAIL",
            detail:
              "artifacts/tv/src/hooks/useLiveSync.ts still defines BroadcastSyncState locally — remove it and import from @workspace/broadcast-types",
          }
        : { status: "PASS" };
    },
  },

  // ── T005: TV libraryRevision SSE sidecar is wired ─────────────────────────

  {
    name: "TV useLiveSync.ts delegates to @workspace/broadcast-sync",
    run: () => {
      const text = readText("artifacts/tv/src/hooks/useLiveSync.ts");
      const delegates =
        text.includes("@workspace/broadcast-sync") && text.includes("useBroadcastSync");
      return delegates
        ? { status: "PASS" }
        : {
            status: "FAIL",
            detail:
              "artifacts/tv/src/hooks/useLiveSync.ts must import and delegate to useBroadcastSync from @workspace/broadcast-sync",
          };
    },
  },

  {
    name: "@workspace/broadcast-sync handles videos-library-updated SSE sidecar",
    run: () => {
      const syncPkg = path.join(ROOT, "lib/broadcast-sync/src/index.ts");
      if (!fs.existsSync(syncPkg)) {
        return { status: "FAIL", detail: "lib/broadcast-sync/src/index.ts not found" };
      }
      const text = readText("lib/broadcast-sync/src/index.ts");
      const hasSse = text.includes("videos-library-updated") && text.includes("EventSource");
      return hasSse
        ? { status: "PASS" }
        : {
            status: "FAIL",
            detail:
              "lib/broadcast-sync/src/index.ts must handle videos-library-updated in the SSE sidecar to activate libraryRevision",
          };
    },
  },

  {
    name: "Mobile useBroadcastSync adapter exists and imports @workspace/broadcast-sync",
    run: () => {
      const adapterPath = path.join(ROOT, "artifacts/mobile/hooks/useBroadcastSync.ts");
      if (!fs.existsSync(adapterPath)) {
        return {
          status: "FAIL",
          detail: "artifacts/mobile/hooks/useBroadcastSync.ts not found — create the Mobile adapter",
        };
      }
      const text = readText("artifacts/mobile/hooks/useBroadcastSync.ts");
      const ok = text.includes("@workspace/broadcast-sync");
      return ok
        ? { status: "PASS" }
        : {
            status: "FAIL",
            detail:
              "artifacts/mobile/hooks/useBroadcastSync.ts must import from @workspace/broadcast-sync",
          };
    },
  },

  {
    name: "Mobile index.tsx handles EMERGENCY_BROADCAST via WS syncState",
    run: () => {
      const text = readText("artifacts/mobile/app/(tabs)/index.tsx");
      const ok =
        text.includes("syncState.emergencyBroadcast") &&
        text.includes("useBroadcastSync");
      return ok
        ? { status: "PASS" }
        : {
            status: "WARN",
            detail:
              "artifacts/mobile/app/(tabs)/index.tsx should use syncState.emergencyBroadcast from useBroadcastSync for OMEGA emergency signals",
          };
    },
  },

  // ── T006: shared lib itself exists and exports key types ──────────────────

  {
    name: `${SHARED_PKG} package exists at lib/broadcast-types`,
    run: () => {
      const exists = fs.existsSync(path.join(ROOT, "lib/broadcast-types/src/index.ts"));
      return exists
        ? { status: "PASS" }
        : {
            status: "FAIL",
            detail: "lib/broadcast-types/src/index.ts not found — create the @workspace/broadcast-types package",
          };
    },
  },

  {
    name: `${SHARED_PKG} exports BroadcastItem, BroadcastCurrentState, GuideItem`,
    run: () => {
      const text = readText("lib/broadcast-types/src/index.ts");
      const required = ["BroadcastItem", "BroadcastCurrentState", "GuideItem", "BroadcastSyncState"];
      const missing = required.filter((t) => !new RegExp(`\\bexport\\b.*\\b${t}\\b`).test(text));
      return missing.length === 0
        ? { status: "PASS" }
        : {
            status: "FAIL",
            detail: `Missing exports from ${SHARED_PKG}: ${missing.join(", ")}`,
          };
    },
  },
];

// ── runner ────────────────────────────────────────────────────────────────────

const ICONS: Record<Status, string> = { PASS: "✓", FAIL: "✗", WARN: "!" };

let failures = 0;
let warnings = 0;

console.log(`\nverify:platform-consistency\n${"─".repeat(60)}`);

for (const check of CHECKS) {
  const { status, detail } = check.run();
  const icon = ICONS[status];
  const label = status.padEnd(4);
  console.log(`  [${icon}] ${label} ${check.name}`);
  if (detail) {
    console.log(`         ${detail}`);
  }
  if (status === "FAIL") failures++;
  if (status === "WARN") warnings++;
}

console.log(`${"─".repeat(60)}`);
const total = CHECKS.length;
const passed = total - failures - warnings;
console.log(`  ${passed} passed, ${warnings} warning(s), ${failures} failed (${total} checks)\n`);

if (failures > 0) {
  console.error(
    `[verify:platform-consistency] FAIL: ${failures} check(s) failed — see details above.\n`,
  );
  process.exit(1);
}
