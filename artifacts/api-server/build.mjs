import { build } from "esbuild";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Build pipeline.
 *
 * Why externalize so much?
 *   - `pg-native`, `bufferutil`, `utf-8-validate` are optional native peer
 *     deps that pull in fragile node-gyp builds when bundled.
 *   - `pino` + `pino-pretty` + `thread-stream` use `worker_threads` and
 *     resolve transport modules at runtime via `require.resolve`. Bundling
 *     them breaks worker-spawn paths. We ship them via node_modules instead.
 *   - `@aws-sdk/*` is huge; bundling triples cold start. Externalizing
 *     keeps the dist artifact small and lets npm dedupe across deploys.
 *   - `@sentry/node` is an optional peer; instrument.mjs imports it
 *     dynamically and tolerates absence.
 */
const root = path.resolve(".");
const out = path.resolve("./dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  banner: {
    js: [
      "import { createRequire as __cjsRequire } from 'node:module';",
      "const require = __cjsRequire(import.meta.url);",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_fn } from 'node:path';",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_fn(__filename);",
    ].join("\n"),
  },
  external: [
    "pg-native",
    "bufferutil",
    "utf-8-validate",
    "pino",
    "pino-pretty",
    "pino-abstract-transport",
    "thread-stream",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "@sentry/node",
    // Externalize @fastify/swagger-ui so it can resolve its bundled
    // static assets (HTML/CSS/JS/SVG) from its own package directory.
    // Bundling breaks the runtime `__dirname/static/...` lookups.
    "@fastify/swagger-ui",
    "@fastify/swagger",
  ],
};

await build({
  ...shared,
  entryPoints: { index: "src/main.ts" },
  outdir: out,
  outExtension: { ".js": ".mjs" },
});

await build({
  ...shared,
  entryPoints: { instrument: "src/instrument.ts" },
  outdir: out,
  outExtension: { ".js": ".mjs" },
});

await build({
  ...shared,
  entryPoints: { openapi: "src/scripts/emit-openapi.ts" },
  outdir: out,
  outExtension: { ".js": ".mjs" },
});

writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify({ type: "module" }, null, 2),
);

console.log("✓ Build complete →", path.relative(root, out));
