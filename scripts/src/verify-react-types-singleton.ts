#!/usr/bin/env tsx
import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PNPM_DIR = resolve(ROOT, "node_modules", ".pnpm");

function fail(msg: string): never {
  console.error(`[verify:react-types-singleton] FAIL — ${msg}`);
  console.error(
    `\nWhy this matters: when two parallel @types/react copies land in node_modules,\n` +
      `the JSX runtime uses one copy while third-party packages (expo-linear-gradient,\n` +
      `expo-blur, expo-image, recharts, etc.) are typed against the other. tsc then sees\n` +
      `their classes as incompatible and emits TS2786 / TS2607 / TS2322 errors that look\n` +
      `like "<X> cannot be used as a JSX component" — which fails the Render deploy.\n\n` +
      `Fix: ensure every artifact references @types/react and @types/react-dom from the\n` +
      `pnpm catalog (in pnpm-workspace.yaml). Hard-pinning a different range in any one\n` +
      `package.json (e.g. "~19.1.17" while the catalog is "~19.1.10") is the trigger.`,
  );
  process.exit(1);
}

if (!existsSync(PNPM_DIR)) {
  fail(`node_modules/.pnpm not found at ${PNPM_DIR} — run \`pnpm install\` first.`);
}

const entries = readdirSync(PNPM_DIR);

const reactTypes = entries.filter((d) => /^@types\+react@[^_]/.test(d));
const reactDomTypes = entries.filter((d) => /^@types\+react-dom@[^_]/.test(d));

const problems: string[] = [];
if (reactTypes.length > 1) {
  problems.push(
    `Found ${reactTypes.length} @types/react versions: ${reactTypes.join(", ")}`,
  );
}
if (reactDomTypes.length > 1) {
  problems.push(
    `Found ${reactDomTypes.length} @types/react-dom versions: ${reactDomTypes.join(", ")}`,
  );
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  fail("multiple React type copies resolved (see above)");
}

const reactT = reactTypes[0] ?? "(none)";
const reactDomT = reactDomTypes[0] ?? "(none)";
console.log(
  `[verify:react-types-singleton] OK — exactly one copy each: ${reactT}, ${reactDomT}`,
);
