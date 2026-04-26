import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

// Orval's split-mode generator emits both `generated/api.ts` (zod schemas
// declared with PascalCase value names like `CreatePlaylistBody`) and
// `generated/types/<name>.ts` (TypeScript interfaces sharing the same names).
// When `lib/api-zod/src/index.ts` re-exports from both with `export *`,
// TS2308 fires because the same identifier appears in two `export *` chains
// even though one is a value and the other a type. Consumers only ever
// import the zod schemas (and zod gives them the inferred type via
// `z.infer<typeof Schema>` if needed), so we collapse the index to a
// single re-export of the schemas. Re-applied after every `orval` run
// because orval owns and rewrites this file.
const apiZodIndex = resolve(root, "lib", "api-zod", "src", "index.ts");
writeFileSync(
  apiZodIndex,
  'export * from "./generated/api";\n',
  "utf8",
);
console.log("[postcodegen] normalized lib/api-zod/src/index.ts");
