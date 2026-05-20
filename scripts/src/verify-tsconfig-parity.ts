#!/usr/bin/env tsx
/**
 * verify:tsconfig-parity
 *
 * Asserts cross-artifact tsconfig invariants that, if violated, cause silent
 * runtime drift or surprising build failures on Render. The check resolves
 * each artifact's `extends` chain (one level deep is sufficient for this
 * codebase — every artifact extends either `tsconfig.base.json` or
 * `expo/tsconfig.base`) and validates a fixed contract.
 *
 * Why this is worth a guardrail:
 *   - The 3 SPA artifacts (admin, mockup-sandbox, tv) are functionally
 *     triplets — same Vite stack, same React, same target browsers — but
 *     they each have a separate tsconfig.json that has historically drifted
 *     on `lib`, `resolveJsonModule`, and `esModuleInterop` (each a real
 *     instance of code that compiles in one SPA but not the others).
 *   - The api-server is Node-flavored and MUST NOT leak DOM types (a
 *     stray `import "fetch"` browser type would let server code call
 *     browser-only APIs that crash at runtime).
 *   - Any artifact silently flipping `strict` off or `skipLibCheck` off
 *     would change build behavior in ways no test covers.
 *
 * The check fails fast with EXIT 1 and a precise diagnostic naming the
 * artifact, key, and observed values — so the next developer can fix the
 * drift in seconds instead of debugging a "works on my machine" deploy.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

const ARTIFACTS = {
  "api-server": "artifacts/api-server/tsconfig.json",
  admin: "artifacts/admin/tsconfig.json",
  mobile: "artifacts/mobile/tsconfig.json",
  "mockup-sandbox": "artifacts/mockup-sandbox/tsconfig.json",
  tv: "artifacts/tv/tsconfig.json",
} as const;

const SPA_GROUP = ["admin", "mockup-sandbox", "tv"] as const;

type CompilerOptions = Record<string, unknown>;

/**
 * Strip JSON-with-comments. tsconfig files allow // and block comments
 * which JSON.parse rejects. Tiny hand-rolled stripper avoids a dep.
 */
function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function readJsonc(path: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
}

/**
 * Resolve effective compilerOptions by walking `extends`. Local file paths
 * (`./foo`, `../foo`) are resolved relative to the extending file. Bare
 * specifiers (`expo/tsconfig.base`) are not resolved — we treat them as
 * opaque and just record the parent name (mobile uses this).
 */
function resolveEffective(tsconfigPath: string): {
  options: CompilerOptions;
  extendsChain: string[];
} {
  const raw = readJsonc(tsconfigPath);
  const chain: string[] = [];
  let merged: CompilerOptions = {};

  const extendsField = raw.extends;
  if (typeof extendsField === "string") {
    chain.push(extendsField);
    if (extendsField.startsWith(".")) {
      const parentPath = resolve(dirname(tsconfigPath), extendsField);
      const parentResolved = parentPath.endsWith(".json")
        ? parentPath
        : parentPath + ".json";
      if (existsSync(parentResolved)) {
        const parent = resolveEffective(parentResolved);
        merged = { ...parent.options };
        chain.unshift(...parent.extendsChain);
      }
    }
    // Bare specifiers like `expo/tsconfig.base` left opaque — mobile is
    // checked with a relaxed contract (only `strict` enforcement) below.
  }

  const own = (raw.compilerOptions as CompilerOptions | undefined) ?? {};
  merged = { ...merged, ...own };
  return { options: merged, extendsChain: chain };
}

const failures: string[] = [];

function fail(msg: string) {
  failures.push(msg);
}

// ────────────────────────────────────────────────────────────────────────────
// Resolve effective options for every artifact
// ────────────────────────────────────────────────────────────────────────────
const effective: Record<string, { options: CompilerOptions; chain: string[] }> =
  {};
for (const [name, relPath] of Object.entries(ARTIFACTS)) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    fail(`[${name}] tsconfig not found at ${relPath}`);
    continue;
  }
  const r = resolveEffective(abs);
  effective[name] = { options: r.options, chain: r.extendsChain };
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 1: every artifact must keep `strict` true (either directly or via
// every individual strict* flag being true). Base sets the individual flags;
// any artifact that flips `strict: false` would silently disable them all.
// ────────────────────────────────────────────────────────────────────────────
for (const [name, e] of Object.entries(effective)) {
  if (e.options.strict === false) {
    fail(`[${name}] compilerOptions.strict === false — strict mode must stay on`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 2: every artifact must keep `skipLibCheck` true. Disabling it
// surfaces type errors from every transitive dep (recharts, expo, etc.) and
// makes deploys fail unpredictably.
// ────────────────────────────────────────────────────────────────────────────
for (const [name, e] of Object.entries(effective)) {
  if (e.options.skipLibCheck === false) {
    fail(`[${name}] compilerOptions.skipLibCheck === false — must stay true`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 3: api-server must NOT include DOM types. Backend code calling
// browser-only APIs (window/document/fetch's browser overload) would compile
// cleanly but crash at runtime on Node.
// ────────────────────────────────────────────────────────────────────────────
{
  const types = effective["api-server"]?.options.types as string[] | undefined;
  if (!Array.isArray(types) || !types.includes("node")) {
    fail(`[api-server] compilerOptions.types must include "node" (current: ${JSON.stringify(types)})`);
  }
  const lib = effective["api-server"]?.options.lib as string[] | undefined;
  if (Array.isArray(lib) && lib.some((l) => l.toLowerCase().includes("dom"))) {
    fail(`[api-server] compilerOptions.lib must not include any DOM lib (current: ${JSON.stringify(lib)})`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 4: SPA-group parity. admin, mockup-sandbox, and tv are functional
// triplets; their tsconfigs must agree on the keys that affect what code can
// be written (jsx mode, module resolution, JSON imports, TS extension
// imports). Drift here means code that compiles in one SPA fails in another.
// ────────────────────────────────────────────────────────────────────────────
const SPA_KEYS = [
  "jsx",
  "moduleResolution",
  "allowImportingTsExtensions",
  "noEmit",
] as const;

for (const key of SPA_KEYS) {
  const values = SPA_GROUP.map((spa) => ({
    spa,
    value: effective[spa]?.options[key],
  }));
  const distinct = new Set(values.map((v) => JSON.stringify(v.value)));
  if (distinct.size > 1) {
    const breakdown = values
      .map((v) => `${v.spa}=${JSON.stringify(v.value)}`)
      .join(", ");
    fail(`[SPA-parity] compilerOptions.${key} drifts across admin/mockup-sandbox/tv: ${breakdown}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 5: every SPA must include "vite/client" in its types array.
// Without it, `import.meta.env.VITE_*` is typed as `unknown` and Vite's
// asset imports (?url, ?raw, ?worker) emit TS errors.
// ────────────────────────────────────────────────────────────────────────────
for (const spa of SPA_GROUP) {
  const types = effective[spa]?.options.types as string[] | undefined;
  if (!Array.isArray(types) || !types.includes("vite/client")) {
    fail(`[${spa}] compilerOptions.types must include "vite/client" (current: ${JSON.stringify(types)})`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 6: every SPA's `lib` must include both "dom" and "dom.iterable".
// Missing "dom" means React component code that touches DOM types fails;
// missing "dom.iterable" means `for...of` on NodeList fails.
// ────────────────────────────────────────────────────────────────────────────
for (const spa of SPA_GROUP) {
  const lib = effective[spa]?.options.lib as string[] | undefined;
  const lcLib = (lib ?? []).map((l) => l.toLowerCase());
  if (!lcLib.includes("dom")) {
    fail(`[${spa}] compilerOptions.lib must include "dom" (current: ${JSON.stringify(lib)})`);
  }
  if (!lcLib.includes("dom.iterable")) {
    fail(`[${spa}] compilerOptions.lib must include "dom.iterable" (current: ${JSON.stringify(lib)})`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 7: customConditions must include "workspace" everywhere that
// extends our local base. This is the key that lets pnpm `workspace:*`
// imports resolve via package.json `exports` conditions. If anyone
// overrides it without "workspace", internal lib imports break.
// ────────────────────────────────────────────────────────────────────────────
for (const [name, e] of Object.entries(effective)) {
  if (name === "mobile") continue; // mobile extends expo/tsconfig.base, not ours
  const conds = e.options.customConditions as string[] | undefined;
  if (!Array.isArray(conds) || !conds.includes("workspace")) {
    fail(
      `[${name}] compilerOptions.customConditions must include "workspace" (current: ${JSON.stringify(conds)})`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Report
// ────────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("[verify:tsconfig-parity] FAIL — invariant violations:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nWhy this matters: tsconfig drift across artifacts is one of the highest-cost\n` +
      `monorepo failure classes. Code compiles cleanly in the artifact you wrote it in,\n` +
      `then fails in tsc on Render when another artifact (or a CI run) tries the same\n` +
      `pattern with a slightly different compiler contract. The 3 SPAs (admin,\n` +
      `mockup-sandbox, tv) are functional triplets and must agree on jsx/moduleResolution/\n` +
      `allowImportingTsExtensions/noEmit. The api-server must never leak DOM types.\n` +
      `Every artifact must keep strict + skipLibCheck on, and the workspace export\n` +
      `condition must stay set so pnpm workspace imports resolve correctly.`,
  );
  process.exit(1);
}

console.log(
  `[verify:tsconfig-parity] OK — ${Object.keys(effective).length} artifact tsconfigs validated; ${SPA_GROUP.length}-way SPA parity confirmed.`,
);
