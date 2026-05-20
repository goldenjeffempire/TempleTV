/**
 * Boot the app just long enough to dump its OpenAPI 3.1 spec to stdout
 * (or a file). Used by the `openapi` npm script and CI to publish the
 * canonical contract.
 *
 *   pnpm --filter @workspace/api-server run openapi > openapi.json
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "../app.js";

async function main() {
  const app = await buildApp();
  await app.ready();
  const spec = app.swagger();
  const out = process.argv[2] ?? "openapi.json";
  const target = resolve(process.cwd(), out);
  await writeFile(target, JSON.stringify(spec, null, 2));
  console.log(`✓ OpenAPI spec written → ${target}`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
