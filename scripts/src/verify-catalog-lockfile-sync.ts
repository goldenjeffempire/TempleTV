#!/usr/bin/env -S node --enable-source-maps
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_FILE = resolve(ROOT, "pnpm-workspace.yaml");
const LOCKFILE = resolve(ROOT, "pnpm-lock.yaml");
const ROOT_PACKAGE_JSON = resolve(ROOT, "package.json");

type LockEntry = { name: string; specifier: string; version: string };

function parseWorkspaceCatalog(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  let inCatalog = false;
  for (const raw of lines) {
    if (/^catalog:\s*$/.test(raw)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog) {
      if (/^\S/.test(raw)) {
        if (raw.trim().length > 0) break;
        continue;
      }
      const trimmed = raw.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^['"]?([^'":\s]+)['"]?\s*:\s*(.+?)\s*$/);
      if (m) out.set(m[1], m[2].replace(/^['"]|['"]$/g, ""));
    }
  }
  return out;
}

function parseLockfileCatalog(text: string): Map<string, LockEntry> {
  const out = new Map<string, LockEntry>();
  const lines = text.split("\n");
  let inCatalogs = false;
  let inDefault = false;
  let currentName: string | null = null;
  let currentSpecifier: string | null = null;
  let currentVersion: string | null = null;
  const flush = () => {
    if (currentName && currentSpecifier && currentVersion) {
      out.set(currentName, {
        name: currentName,
        specifier: currentSpecifier,
        version: currentVersion,
      });
    }
    currentName = null;
    currentSpecifier = null;
    currentVersion = null;
  };
  for (const raw of lines) {
    if (/^catalogs:\s*$/.test(raw)) {
      inCatalogs = true;
      continue;
    }
    if (inCatalogs && /^\S/.test(raw)) {
      flush();
      break;
    }
    if (!inCatalogs) continue;
    if (/^\s{2}default:\s*$/.test(raw)) {
      inDefault = true;
      continue;
    }
    if (inDefault && /^\s{2}\S/.test(raw)) {
      flush();
      inDefault = false;
      continue;
    }
    if (!inDefault) continue;
    const nameMatch = raw.match(/^\s{4}['"]?([^'":\s]+)['"]?\s*:\s*$/);
    if (nameMatch) {
      flush();
      currentName = nameMatch[1];
      continue;
    }
    const specMatch = raw.match(/^\s{6}specifier:\s*(.+?)\s*$/);
    if (specMatch) {
      currentSpecifier = specMatch[1].replace(/^['"]|['"]$/g, "");
      continue;
    }
    const verMatch = raw.match(/^\s{6}version:\s*(.+?)\s*$/);
    if (verMatch) {
      currentVersion = verMatch[1].replace(/^['"]|['"]$/g, "");
      continue;
    }
  }
  flush();
  return out;
}

function parseSemver(v: string): [number, number, number] | null {
  const cleaned = v.replace(/[(].*$/, "").trim();
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function satisfies(version: string, spec: string): boolean {
  const v = parseSemver(version);
  if (!v) return true;
  const trimmed = spec.trim();
  const caret = trimmed.match(/^\^(\d+)\.(\d+)\.(\d+)/);
  if (caret) {
    const [, M, m, p] = caret.map(Number);
    if (M > 0) return v[0] === M && (v[1] > m || (v[1] === m && v[2] >= p));
    if (m > 0) return v[0] === 0 && v[1] === m && v[2] >= p;
    return v[0] === 0 && v[1] === 0 && v[2] === p;
  }
  const tilde = trimmed.match(/^~(\d+)\.(\d+)\.(\d+)/);
  if (tilde) {
    const [, M, m, p] = tilde.map(Number);
    return v[0] === M && v[1] === m && v[2] >= p;
  }
  const exact = trimmed.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (exact) {
    const [, M, m, p] = exact.map(Number);
    return v[0] === M && v[1] === m && v[2] === p;
  }
  return true;
}

function findResolvedVersion(text: string, name: string): string | null {
  // Walk lockfile importer/snapshot blocks and find the most-resolved version
  // for `name`. We only care about the major.minor.patch prefix so any peer-dep
  // suffix is fine. Match either `name:\n      version: X` or in dep maps.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s+${escaped}:\\s*\\n\\s+specifier:[^\\n]*\\n\\s+version:\\s*([^\\s\\n]+)`, "gm");
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

const ws = readFileSync(WORKSPACE_FILE, "utf8");
const lf = readFileSync(LOCKFILE, "utf8");
const rootPkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8")) as {
  pnpm?: { overrides?: Record<string, string> };
};
const overrides = new Map<string, string>(
  Object.entries(rootPkg.pnpm?.overrides ?? {}).filter(
    // only top-level overrides (no `>` in key — those are nested transitive overrides)
    ([k]) => !k.includes(">"),
  ),
);

const wsCatalog = parseWorkspaceCatalog(ws);
const lfCatalog = parseLockfileCatalog(lf);

const drift: Array<{
  name: string;
  workspaceSpec: string;
  lockSpec: string | undefined;
  resolved: string | undefined;
  reason: string;
}> = [];

for (const [name, wsSpec] of wsCatalog) {
  const lfEntry = lfCatalog.get(name);
  const overrideSpec = overrides.get(name);

  if (!lfEntry) {
    // Not in lockfile catalog snapshot. Two legitimate possibilities:
    //   (a) An override displaced the catalog reference everywhere — pnpm
    //       strips the catalog entry from the lockfile snapshot in that case.
    //   (b) The catalog is genuinely stale and `pnpm install` was never run.
    if (overrideSpec) {
      const resolvedRaw = findResolvedVersion(lf, name);
      const resolvedClean = resolvedRaw?.replace(/[(].*$/, "") ?? null;
      if (resolvedClean && !satisfies(resolvedClean, wsSpec)) {
        drift.push({
          name,
          workspaceSpec: wsSpec,
          lockSpec: `(displaced by root pnpm.overrides: "${overrideSpec}")`,
          resolved: resolvedClean,
          reason: `the root \`pnpm.overrides\` for "${name}" is forcing version ${resolvedClean}, which does NOT satisfy the catalog specifier "${wsSpec}". Reading the catalog gives a misleading mental model. Either widen the catalog specifier to match the override (e.g. set the catalog to a range that includes ${resolvedClean}) or remove the override and let the catalog control resolution.`,
        });
      }
      // override exists AND resolved version satisfies catalog spec → not drift, keep silent
      continue;
    }
    drift.push({
      name,
      workspaceSpec: wsSpec,
      lockSpec: undefined,
      resolved: undefined,
      reason: "missing from lockfile catalog snapshot and no root `pnpm.overrides` explains the absence — most likely the catalog was edited without running `pnpm install`. Run `pnpm install` to refresh the lockfile.",
    });
    continue;
  }
  if (lfEntry.specifier !== wsSpec) {
    drift.push({
      name,
      workspaceSpec: wsSpec,
      lockSpec: lfEntry.specifier,
      resolved: lfEntry.version,
      reason: `lockfile catalog specifier "${lfEntry.specifier}" does not match workspace catalog "${wsSpec}" (run \`pnpm install\` to refresh lockfile)`,
    });
    continue;
  }
  if (!satisfies(lfEntry.version, wsSpec)) {
    drift.push({
      name,
      workspaceSpec: wsSpec,
      lockSpec: lfEntry.specifier,
      resolved: lfEntry.version,
      reason: `resolved version "${lfEntry.version}" does NOT satisfy catalog specifier "${wsSpec}" (likely a root \`pnpm.overrides\` is forcing the resolution past the catalog range — update the catalog specifier to reflect reality, or remove the override)`,
    });
  }
}

if (drift.length === 0) {
  console.log(
    `[verify:catalog] OK — ${wsCatalog.size} catalog entries, all in sync with lockfile.`,
  );
  process.exit(0);
}

console.error(
  `\n[verify:catalog] FAIL — ${drift.length} of ${wsCatalog.size} catalog entries are out of sync with the lockfile:\n`,
);
for (const d of drift) {
  console.error(`  • ${d.name}`);
  console.error(`      pnpm-workspace.yaml catalog: ${d.workspaceSpec}`);
  if (d.lockSpec !== undefined) {
    console.error(`      pnpm-lock.yaml catalog spec: ${d.lockSpec}`);
  }
  if (d.resolved !== undefined) {
    console.error(`      pnpm-lock.yaml resolved:     ${d.resolved}`);
  }
  console.error(`      → ${d.reason}\n`);
}
console.error(
  `[verify:catalog] Drift means developers reading pnpm-workspace.yaml will form an incorrect mental model of which versions are actually shipping. Fix by either updating the catalog specifier to match what's installed, or running \`pnpm install\` to regenerate the lockfile from the catalog.\n`,
);
process.exit(1);
