#!/usr/bin/env tsx
/**
 * verify:db-schema-completeness
 *
 * Asserts that every Drizzle schema file in `lib/db/src/schema/` is wired
 * into the schema barrel `lib/db/src/schema/index.ts` so that `drizzle-kit
 * push` actually sees every table that exists in TypeScript.
 *
 * Why this is worth a dedicated guardrail (failure mode this prevents):
 *   This codebase deliberately uses `drizzle-kit push` (no SQL migration
 *   files — `lib/db/package.json` only declares `push` and `push-force`
 *   scripts; render.yaml never invokes either). In push mode, the live
 *   database schema is reconciled against whatever drizzle-kit can REACH
 *   from the schema entrypoint configured in `drizzle.config.ts`:
 *
 *     schema: path.join(__dirname, "./src/schema/index.ts")
 *
 *   That entrypoint is a hand-maintained barrel — a list of `export *
 *   from "./<filename>"` lines, one per schema file. If a new schema file
 *   is added but the operator forgets to add the matching `export *` line
 *   (extremely easy to miss in a PR review — barrel files are typically
 *   skipped during code review because "they're just re-exports"), the
 *   tables in that file become INVISIBLE to drizzle-kit:
 *
 *     - `drizzle-kit push` will not create the tables in any database
 *     - Production deploys succeed without warning
 *     - The first runtime query against the missing table throws
 *       `relation "..." does not exist` from Postgres
 *     - No static analysis catches it: TypeScript is fine because the
 *       schema TS file compiles in isolation; the api-server type-checks
 *       fine because it imports from `@workspace/db/schema` which IS the
 *       barrel — but only the EXISTING re-exports are present, so a
 *       missing one looks like a missing import (which the dev would
 *       have noticed) rather than a missing barrel entry.
 *
 *   The same class of bug works in reverse: stale `export *` lines for
 *   files that were deleted or renamed cause TypeScript module-resolution
 *   errors at build time but are easy to miss when running only the
 *   compiled api-server (which imports specific symbols, not `*`).
 *
 *   Bonus invariant: every schema file should declare at least one
 *   `pgTable(...)` call. An empty schema file is almost always a stub
 *   that someone forgot to fill in, or a file left behind after a table
 *   was deleted. Catching it here saves the operator from chasing a
 *   "table mysteriously absent in production" investigation.
 *
 * What's deliberately NOT enforced:
 *   - Comparing TypeScript schema against the live database schema (would
 *     require a DB connection at verify time and is push-mode's whole job
 *     — duplicating it here would be slow and brittle).
 *   - Whether tables have appropriate indexes / foreign keys / nullability
 *     — those are design decisions, not drift-prevention concerns.
 *   - Migration ordering / monotonic numbering — there are no migrations
 *     in this project. `db:push` reconciles directly from TS to DB.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SCHEMA_DIR = join(ROOT, "lib", "db", "src", "schema");
const BARREL_PATH = join(SCHEMA_DIR, "index.ts");

if (!existsSync(SCHEMA_DIR) || !statSync(SCHEMA_DIR).isDirectory()) {
  console.error(
    `[verify:db-schema-completeness] FAIL — schema directory not found at ${SCHEMA_DIR}`,
  );
  process.exit(1);
}
if (!existsSync(BARREL_PATH)) {
  console.error(
    `[verify:db-schema-completeness] FAIL — schema barrel not found at ${BARREL_PATH}`,
  );
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// Enumerate the on-disk schema files (excluding the barrel itself).
// ────────────────────────────────────────────────────────────────────────────
const schemaFiles = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .sort();

// Strip ".ts" — barrel re-exports use the no-extension convention.
const fileStems = schemaFiles.map((f) => f.replace(/\.ts$/, ""));

// ────────────────────────────────────────────────────────────────────────────
// Parse the barrel for `export * from "./X"` re-exports.
// Tolerates single + double quotes, optional trailing semicolon, optional
// whitespace, optional `.ts` / `.js` suffix on the path.
// ────────────────────────────────────────────────────────────────────────────
const barrelSrc = readFileSync(BARREL_PATH, "utf8");
const exportRe = /^\s*export\s+\*\s+from\s+["'](\.\/[^"']+)["']\s*;?\s*$/gm;

const barrelExports: string[] = [];
let match: RegExpExecArray | null;
while ((match = exportRe.exec(barrelSrc)) !== null) {
  // Strip "./" prefix and ".ts"/".js" suffix to get the stem.
  let stem = match[1].slice(2);
  stem = stem.replace(/\.(ts|js|mts|mjs)$/, "");
  barrelExports.push(stem);
}

const errors: string[] = [];

// ── Invariant 1: every on-disk schema file must be re-exported by index.ts.
const barrelSet = new Set(barrelExports);
for (const stem of fileStems) {
  if (!barrelSet.has(stem)) {
    errors.push(
      `Schema file "lib/db/src/schema/${stem}.ts" exists on disk but is NOT re-exported by lib/db/src/schema/index.ts — its tables would be INVISIBLE to \`drizzle-kit push\` and silently never created in production. Add: export * from "./${stem}";`,
    );
  }
}

// ── Invariant 2: every barrel re-export must point to a real file.
const fileSet = new Set(fileStems);
const seenInBarrel = new Set<string>();
for (const stem of barrelExports) {
  if (!fileSet.has(stem)) {
    errors.push(
      `lib/db/src/schema/index.ts re-exports \`./${stem}\` but lib/db/src/schema/${stem}.ts does not exist (file was deleted or renamed?) — would break TypeScript module resolution at build time. Remove the stale export.`,
    );
  }
  if (seenInBarrel.has(stem)) {
    errors.push(
      `lib/db/src/schema/index.ts re-exports \`./${stem}\` more than once — duplicate \`export * from\` line; remove the redundant one.`,
    );
  }
  seenInBarrel.add(stem);
}

// ── Invariant 3: every schema file must declare at least one pgTable(...)
// call. Empty stub files are almost always bugs.
const pgTableRe = /\bpgTable\s*\(/;
for (const stem of fileStems) {
  const filePath = join(SCHEMA_DIR, `${stem}.ts`);
  const src = readFileSync(filePath, "utf8");
  if (!pgTableRe.test(src)) {
    errors.push(
      `Schema file "lib/db/src/schema/${stem}.ts" contains no \`pgTable(...)\` call — empty stub or stale file. Either declare at least one table or delete the file (and remove its barrel re-export).`,
    );
  }
}

// ── Invariant 4: no duplicate table names across schema files. Drizzle
// allows it (last-loaded wins) but it's almost always a copy-paste bug.
// Match the literal string passed as the FIRST arg to pgTable(...). We
// don't try to evaluate template strings or constants — only literal "..."
// or '...' which is by far the dominant convention.
const tableNameRe = /\bpgTable\s*\(\s*["']([^"']+)["']/g;
const tableOwners = new Map<string, string[]>(); // tableName → owning file stems
for (const stem of fileStems) {
  const filePath = join(SCHEMA_DIR, `${stem}.ts`);
  const src = readFileSync(filePath, "utf8");
  let m: RegExpExecArray | null;
  const nameRe = new RegExp(tableNameRe.source, tableNameRe.flags);
  while ((m = nameRe.exec(src)) !== null) {
    const tableName = m[1];
    const owners = tableOwners.get(tableName) ?? [];
    owners.push(stem);
    tableOwners.set(tableName, owners);
  }
}
for (const [tableName, owners] of tableOwners) {
  if (owners.length > 1) {
    errors.push(
      `Postgres table name "${tableName}" is declared in multiple schema files: ${owners.map((o) => `lib/db/src/schema/${o}.ts`).join(", ")} — drizzle-kit push will silently use only one definition (load order dependent). Almost always a copy-paste bug; rename one of the tables.`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Report.
// ────────────────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error(
    `[verify:db-schema-completeness] FAIL — ${errors.length} schema-completeness invariant violation(s):`,
  );
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\nWhy this matters:\n  This codebase uses \`drizzle-kit push\` (not migrations). drizzle-kit\n  reaches tables ONLY through whatever the schema barrel re-exports. A\n  schema file that exists on disk but is missing from the barrel is\n  effectively dead code from the database's perspective: tables are never\n  created in production, the first query against them throws \`relation\n  "..." does not exist\`, and no compile-time check surfaces the gap.\n\nFix the violation(s) above and re-run \`pnpm run verify:db-schema-completeness\`.`,
  );
  process.exit(1);
}

const totalTables = Array.from(tableOwners.keys()).length;
console.log(
  `[verify:db-schema-completeness] OK — ${fileStems.length} schema file(s), ${barrelExports.length} barrel re-export(s) all resolved, ${totalTables} unique pgTable(...) declaration(s); every schema file is reachable by \`drizzle-kit push\`.`,
);
