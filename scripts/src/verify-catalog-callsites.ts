#!/usr/bin/env tsx
/**
 * verify:catalog-callsites
 *
 * Asserts that every workspace package.json references catalog-managed
 * packages via the literal `"catalog:"` token rather than a hardcoded
 * version range. Without this guardrail, the centralized version control
 * established by `pnpm-workspace.yaml`'s `catalog:` block can be silently
 * bypassed — and every prior round's hardening that depends on catalog
 * pinning can quietly regress.
 *
 * Why this is worth a dedicated guardrail (failure mode this prevents):
 *   Round 9 of the deploy hardening sweep caught a Render production
 *   build that detected two parallel `@types/react` installs (19.1.17 and
 *   19.2.14). The fix had two layers:
 *     (1) catalog moved to exact pins (no `^` or `~`) for react /
 *         react-dom / @types/react / @types/react-dom
 *     (2) `pnpm.overrides` in root package.json forces every transitive
 *         resolution to the same exact version regardless of any peer
 *         range
 *   Both layers depend on consuming workspace packages actually
 *   referencing the catalog. If a developer copy-pastes a package.json
 *   stanza from a tutorial and writes:
 *     "react": "^19.1.0"
 *   instead of:
 *     "react": "catalog:"
 *   …pnpm will resolve the LOCAL hardcoded range. If that range admits
 *   any version other than 19.1.0 (and `^19.1.0` admits 19.2.x), pnpm
 *   may install a SECOND copy alongside the catalog version, and Round
 *   9's singleton invariant silently breaks. The duplicate-react warning
 *   that took half a deploy cycle to chase down comes back.
 *
 *   Same risk class for every other catalog package:
 *     - drizzle-orm drift across api-server / lib/db breaks query type
 *       inference
 *     - vite drift across the 3 SPAs causes plugin-version mismatches
 *       that surface as cryptic "Cannot read properties of undefined"
 *       errors at build time
 *     - zod drift breaks the shared @workspace/api-zod schemas
 *
 *   This guardrail makes hardcoded callsites for catalog-managed packages
 *   structurally impossible to commit, so every prior round's hardening
 *   that depends on catalog discipline (Round 7 react types singleton,
 *   Round 8 tsconfig parity, Round 9 catalog/lockfile sync) stays
 *   protected from a single careless line in a single package.json.
 *
 *   Bonus invariant: dead catalog entries (declared in catalog but
 *   referenced by zero workspace packages) accumulate and mislead the
 *   next operator. Same cleanup principle as `verify:env-secrets`'s
 *   dead-envVarGroup check.
 *
 * What's deliberately NOT enforced:
 *   - peerDependencies — these are semantically RANGES (`>=18`, etc.),
 *     not pins. lib/api-client-react legitimately declares
 *     `"react": ">=18"` as its peer requirement; rewriting that to
 *     `"catalog:"` would change the semantic meaning. peerDeps are
 *     skipped entirely.
 *   - `workspace:*` references — these point at sibling monorepo packages,
 *     not external npm packages, so they're orthogonal to catalog.
 *   - Hardcoded versions for packages NOT in the catalog (e.g. recharts,
 *     date-fns, the radix-ui galaxy) — those packages are deliberately
 *     not centralized, so per-package version freedom is the intended
 *     posture.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_YAML_PATH = join(ROOT, "pnpm-workspace.yaml");

if (!existsSync(WORKSPACE_YAML_PATH)) {
  console.error(
    `[verify:catalog-callsites] FAIL — pnpm-workspace.yaml not found at ${WORKSPACE_YAML_PATH}`,
  );
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// Parse the catalog block out of pnpm-workspace.yaml.
//
// The block looks like:
//   catalog:
//     '@types/react': 19.2.14
//     react: 19.1.0
//     # comment
//     'some-pkg': ^1.2.3
//
// We slice from the line `catalog:` to the next top-level key (no
// indent) and pull `key: value` pairs from indented lines, tolerating
// quoted/unquoted keys and comment lines.
// ────────────────────────────────────────────────────────────────────────────
function parseCatalog(yamlText: string): Map<string, string> {
  const lines = yamlText.split("\n");
  const out = new Map<string, string>();
  let inCatalog = false;
  for (const line of lines) {
    if (/^catalog:\s*$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) continue;
    // A new top-level key (no leading whitespace) ends the catalog block.
    if (/^[a-zA-Z]/.test(line)) {
      inCatalog = false;
      continue;
    }
    // Skip pure-comment lines and blank lines.
    if (/^\s*#/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    // Match: 2-space indent, optional quote, package name, colon, version.
    // Strip any trailing inline comment.
    const m = line.match(/^\s+['"]?([^'":]+)['"]?:\s*([^\s#]+)(?:\s*#.*)?$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const workspaceYaml = readFileSync(WORKSPACE_YAML_PATH, "utf8");
const catalog = parseCatalog(workspaceYaml);

if (catalog.size === 0) {
  console.error(
    `[verify:catalog-callsites] FAIL — could not parse any entries from the \`catalog:\` block in pnpm-workspace.yaml. Did the format change?`,
  );
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// Discover every workspace package.json. We use the `packages:` block from
// pnpm-workspace.yaml as the source of truth for what counts as a workspace
// package, plus the root package.json itself (which is not in `packages:`
// but is part of the monorepo).
//
// For this project the packages list is:
//   - artifacts/*
//   - lib/*
//   - lib/integrations/*
//   - scripts
// We expand each glob by reading the directory.
// ────────────────────────────────────────────────────────────────────────────
function expandWorkspaceGlob(spec: string): string[] {
  // `scripts` is a literal directory; `artifacts/*` is a one-level glob.
  if (!spec.includes("*")) {
    const p = join(ROOT, spec);
    return existsSync(p) && statSync(p).isDirectory() ? [p] : [];
  }
  const [parent, pattern] = spec.split("/*");
  if (pattern !== "" && pattern !== undefined) {
    // We don't support multi-level globs in this tiny resolver — none are
    // present in this project's pnpm-workspace.yaml.
    return [];
  }
  const parentPath = join(ROOT, parent);
  if (!existsSync(parentPath) || !statSync(parentPath).isDirectory()) return [];
  return readdirSync(parentPath)
    .map((name) => join(parentPath, name))
    .filter((p) => statSync(p).isDirectory());
}

function parsePackagesBlock(yamlText: string): string[] {
  const lines = yamlText.split("\n");
  let inPackages = false;
  const specs: string[] = [];
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^[a-zA-Z]/.test(line)) {
      inPackages = false;
      continue;
    }
    const m = line.match(/^\s+-\s+(\S+)/);
    if (m) specs.push(m[1]);
  }
  return specs;
}

const packageSpecs = parsePackagesBlock(workspaceYaml);
const workspaceDirs: string[] = [];
for (const spec of packageSpecs) {
  for (const dir of expandWorkspaceGlob(spec)) {
    if (existsSync(join(dir, "package.json"))) workspaceDirs.push(dir);
  }
}
// Root package.json — included so a hardcoded catalog package in the root
// devDependencies (e.g. for a script) is also caught.
workspaceDirs.unshift(ROOT);

// ────────────────────────────────────────────────────────────────────────────
// Walk every workspace package.json. For each catalog package found in
// `dependencies` or `devDependencies` (NOT `peerDependencies` — see header
// comment), the value MUST be the literal string "catalog:".
// ────────────────────────────────────────────────────────────────────────────
interface Violation {
  packageJsonRel: string;
  depName: string;
  hardcodedValue: string;
  expectedCatalogVersion: string;
  field: "dependencies" | "devDependencies";
}

const violations: Violation[] = [];
const catalogReferences = new Map<string, string[]>(); // catalog pkg → list of consuming workspace dirs

for (const dir of workspaceDirs) {
  const pkgJsonPath = join(dir, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch (err) {
    console.error(
      `[verify:catalog-callsites] FAIL — could not parse ${pkgJsonPath}: ${(err as Error).message}`,
    );
    process.exit(1);
  }
  const rel =
    dir === ROOT ? "package.json" : `${dir.replace(ROOT + "/", "")}/package.json`;

  for (const field of ["dependencies", "devDependencies"] as const) {
    const block = pkg[field];
    if (!block || typeof block !== "object") continue;
    for (const [depName, depValue] of Object.entries(
      block as Record<string, string>,
    )) {
      if (!catalog.has(depName)) continue;
      // Track usage for dead-catalog detection.
      const refs = catalogReferences.get(depName) ?? [];
      refs.push(rel);
      catalogReferences.set(depName, refs);
      // Enforce the literal "catalog:" reference.
      if (depValue !== "catalog:") {
        violations.push({
          packageJsonRel: rel,
          depName,
          hardcodedValue: depValue,
          expectedCatalogVersion: catalog.get(depName)!,
          field,
        });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Dead-catalog-entry detection: every catalog entry should be referenced
// by at least one workspace package. Otherwise it's a stale pin that
// nothing consumes.
// ────────────────────────────────────────────────────────────────────────────
const deadEntries: string[] = [];
for (const [pkg] of catalog) {
  if (!catalogReferences.has(pkg)) deadEntries.push(pkg);
}

// ────────────────────────────────────────────────────────────────────────────
// Report.
// ────────────────────────────────────────────────────────────────────────────
const errors: string[] = [];

for (const v of violations) {
  errors.push(
    `[${v.packageJsonRel}] ${v.field}["${v.depName}"] = "${v.hardcodedValue}" — must be "catalog:" (catalog declares this package at ${v.expectedCatalogVersion}). A hardcoded range here BYPASSES the catalog and lets pnpm resolve a different version locally, which can reintroduce the duplicate-install class that Round 9 just eliminated. Fix: change the value to the literal string "catalog:".`,
  );
}

for (const pkg of deadEntries) {
  errors.push(
    `Catalog declares "${pkg}: ${catalog.get(pkg)}" but no workspace package.json references it via "catalog:" — dead pin; either remove from catalog or wire it up in the consuming package(s).`,
  );
}

if (errors.length > 0) {
  console.error(
    `[verify:catalog-callsites] FAIL — ${errors.length} catalog discipline violation(s):`,
  );
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\nWhy this matters:\n  pnpm's catalog is the single source of truth for shared dependency versions\n  across the monorepo. Every workspace package that needs a catalog-managed\n  package MUST reference it via the literal "catalog:" token. A hardcoded\n  version range silently bypasses the catalog and lets pnpm resolve a\n  different version locally, breaking the singleton invariants that Rounds\n  7-9 of the deploy hardening sweep depend on.\n\nFix the violation(s) above and re-run \`pnpm run verify:catalog-callsites\`.`,
  );
  process.exit(1);
}

const totalRefs = Array.from(catalogReferences.values()).reduce(
  (acc, refs) => acc + refs.length,
  0,
);
console.log(
  `[verify:catalog-callsites] OK — ${catalog.size} catalog entries, ${workspaceDirs.length} workspace package.json file(s), ${totalRefs} catalog reference(s) across the monorepo; every catalog-managed package is referenced via the literal "catalog:" token in every consuming package.json, and every catalog entry is consumed by at least one workspace package.`,
);
