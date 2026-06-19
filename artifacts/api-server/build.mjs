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
    "pg",
    "pg-protocol",
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
    // OTel packages are loaded only from instrument.ts via dynamic import.
    // Externalising them keeps the main bundle clean and avoids conflicts
    // with the require-in-the-middle hooks OTel installs at startup.
    "@opentelemetry/sdk-node",
    "@opentelemetry/auto-instrumentations-node",
    "@opentelemetry/exporter-prometheus",
    "@opentelemetry/api",
    // @fastify/compress uses readable-stream which has CJS internals that
    // esbuild cannot resolve through pnpm's virtual store symlinks.
    // Externalise the whole package so it loads from node_modules at runtime.
    "@fastify/compress",
    // jose v6 uses a web-only export map (dist/webapi/*) that esbuild cannot
    // resolve on the Node.js platform. Externalise it so Node loads it via its
    // own CJS/ESM resolver which honours the "node" exports condition.
    "jose",
    // nodemailer v8 uses CJS-only internal requires that esbuild cannot
    // resolve through pnpm's virtual store when bundling. Externalise it.
    "nodemailer",
    // asn1.js (transitive dep) requires minimalistic-assert which esbuild
    // cannot resolve through pnpm's virtual store symlinks. Externalise both.
    "asn1.js",
    "minimalistic-assert",
    "minimalistic-crypto-utils",
    // undici v7 uses CJS internally but esbuild cannot resolve its internal
    // sub-path requires through pnpm's virtual store symlinks. Externalise it
    // so Node loads it via its own resolver at runtime.
    "undici",
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

// The openapi bundle is a dev-only codegen script that emits the OpenAPI JSON
// spec — it is never loaded at runtime by the server.  Skipping source maps
// here saves ~12 MiB of output and reduces peak esbuild memory by roughly
// one-third, cutting the build-step RSS spike from ~1 GB to ~700 MB.
await build({
  ...shared,
  sourcemap: false,
  entryPoints: { openapi: "src/scripts/emit-openapi.ts" },
  outdir: out,
  outExtension: { ".js": ".mjs" },
});

writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify({ type: "module" }, null, 2),
);

console.log("✓ Build complete →", path.relative(root, out));
