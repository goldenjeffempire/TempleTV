#!/usr/bin/env tsx
/**
 * verify:render-yaml
 *
 * Asserts cross-service invariants on `render.yaml` so that a copy-paste
 * mistake on any single service can never cause a security-header gap or a
 * deploy-config drift in production.
 *
 * Why this is worth a guardrail (history):
 *   - Round 6 of the deploy hardening sweep manually added HSTS + Permissions-
 *     Policy + COOP to the 3 static SPAs because they had drifted apart over
 *     time — admin had headers web/tv didn't, and vice versa. There was no
 *     mechanism to prevent the same drift from happening again the next time
 *     someone edits the file.
 *   - Static services (`runtime: static`) had a stale `PORT` envVar that did
 *     nothing on Render's CDN-served static layer but suggested an incorrect
 *     mental model. We removed it, and we want it to stay removed.
 *   - The 3 SPAs share a deliberate hardening posture — same HSTS lifetime,
 *     same Referrer-Policy, same Permissions-Policy, same X-Content-Type-
 *     Options. A drift on any one of these means one SPA gets weaker
 *     browser-side hardening than the other two.
 *
 * What's deliberately NOT enforced:
 *   - X-Frame-Options legitimately differs (admin=DENY, web=SAMEORIGIN for
 *     the Expo PWA preview embedding, tv=SAMEORIGIN for Tizen/webOS WebView
 *     shells). Both are valid hardening choices — the bug would be ABSENCE
 *     of any value, not value drift. So we check presence only.
 *   - COOP is admin-only by design (only admin needs process-level isolation
 *     for its session). We don't enforce parity, just sanity (if admin has
 *     COOP, value must be `same-origin`).
 *
 * Failure modes covered:
 *   - PORT envVar regression on a static service
 *   - Missing HSTS / X-Content-Type-Options / Referrer-Policy / Permissions-
 *     Policy on any SPA
 *   - Drift in HSTS lifetime / Referrer-Policy / Permissions-Policy / X-
 *     Content-Type-Options across SPAs
 *   - Build command no longer runs `verify:production` (would let bad code ship)
 *   - api-server health check path missing
 *   - Frozen lockfile flag missing from any install command
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RENDER_YAML_PATH = join(ROOT, "render.yaml");

if (!existsSync(RENDER_YAML_PATH)) {
  console.error(`[verify:render-yaml] FAIL — render.yaml not found at ${RENDER_YAML_PATH}`);
  process.exit(1);
}

const src = readFileSync(RENDER_YAML_PATH, "utf8");

// ────────────────────────────────────────────────────────────────────────────
// Slice the document into per-service blocks. A service block starts at
// `  - type: web` or `  - type: worker` (2-space indent) and runs until the
// next 2-space `  - type:` or end-of-file.
// ────────────────────────────────────────────────────────────────────────────
interface ServiceBlock {
  type: string;
  name: string;
  runtime: string;
  env: string;
  body: string;
  startLine: number;
}

function sliceServices(text: string): ServiceBlock[] {
  const lines = text.split("\n");
  const services: ServiceBlock[] = [];
  let current: { startIdx: number; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n");
    const typeMatch = body.match(/^\s*- type:\s*(\S+)/m);
    const nameMatch = body.match(/^\s{4}name:\s*(\S+)/m);
    const runtimeMatch = body.match(/^\s{4}runtime:\s*(\S+)/m);
    const envMatch = body.match(/^\s{4}env:\s*(\S+)/m);
    if (typeMatch && nameMatch) {
      services.push({
        type: typeMatch[1],
        name: nameMatch[1],
        runtime: runtimeMatch?.[1] ?? "",
        env: envMatch?.[1] ?? "",
        body,
        startLine: current.startIdx + 1,
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {2}- type:\s/.test(line)) {
      flush();
      current = { startIdx: i, lines: [line] };
    } else if (current) {
      // continuation: as long as the line is indented OR blank OR is a
      // comment line, it belongs to the current service
      if (line === "" || /^\s/.test(line) || line.startsWith("#")) {
        current.lines.push(line);
      } else {
        flush();
      }
    }
  }
  flush();
  return services;
}

// ────────────────────────────────────────────────────────────────────────────
// Within a service body, extract the `headers:` block as an array of
// `{path, name, value}` items. Returns [] if no headers block exists.
// ────────────────────────────────────────────────────────────────────────────
interface HeaderEntry {
  path: string;
  name: string;
  value: string;
}

function extractHeaders(body: string): HeaderEntry[] {
  const lines = body.split("\n");
  let inHeaders = false;
  const headers: HeaderEntry[] = [];
  let current: Partial<HeaderEntry> = {};

  const flushCurrent = () => {
    if (current.path && current.name && current.value !== undefined) {
      headers.push({
        path: current.path,
        name: current.name,
        value: current.value,
      });
    }
    current = {};
  };

  for (const line of lines) {
    if (/^\s{4}headers:\s*$/.test(line)) {
      inHeaders = true;
      continue;
    }
    if (!inHeaders) continue;

    // headers ends when we see a sibling key at the same 4-space indent
    // (e.g. `    routes:`) — but NOT if the line is indented deeper (still
    // inside a header item).
    if (/^\s{4}\w/.test(line) && !/^\s{4}headers:/.test(line)) {
      flushCurrent();
      inHeaders = false;
      continue;
    }

    // start of a new header item: `      - path: /*`
    const pathStart = line.match(/^\s{6}- path:\s*(.+?)\s*$/);
    if (pathStart) {
      flushCurrent();
      current.path = pathStart[1];
      continue;
    }

    // continuation field of the current header item
    const nameMatch = line.match(/^\s{8}name:\s*(.+?)\s*$/);
    if (nameMatch) {
      current.name = nameMatch[1];
      continue;
    }
    const valueMatch = line.match(/^\s{8}value:\s*(.+?)\s*$/);
    if (valueMatch) {
      // strip surrounding quotes if present
      let v = valueMatch[1];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      current.value = v;
      continue;
    }
  }
  flushCurrent();
  return headers;
}

// ────────────────────────────────────────────────────────────────────────────
// Collect failures
// ────────────────────────────────────────────────────────────────────────────
const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

const services = sliceServices(src);

// Sanity: expect 4 services (api, admin, web, tv).
// temple-tv-transcoder was removed in the free-tier edition — Render has no
// free tier for worker services (minimum Starter at $7/month). The transcoder
// dispatcher runs disabled (TRANSCODER_DISABLE=true) inside the API process
// to avoid memory pressure on the 512 MiB free-tier instance. Re-add a
// separate worker entry and update this list when upgrading to a paid plan.
const EXPECTED_SERVICES = [
  "temple-tv-api",
  "temple-tv-admin",
  "temple-tv-web",
  "temple-tv-tv",
] as const;

for (const expected of EXPECTED_SERVICES) {
  if (!services.find((s) => s.name === expected)) {
    fail(`missing service "${expected}" in render.yaml`);
  }
}

const STATIC_SPAS = services.filter(
  (s) => s.env === "static" && EXPECTED_SERVICES.includes(s.name as never),
);

if (STATIC_SPAS.length !== 3) {
  fail(
    `expected exactly 3 static SPAs (admin/web/tv), found ${STATIC_SPAS.length}: ${STATIC_SPAS.map((s) => s.name).join(", ") || "(none)"}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 1: no static SPA may declare a PORT envVar (Render's CDN serves
// static files via `env: static`; PORT is dead config and misleads the next
// operator).
// ────────────────────────────────────────────────────────────────────────────
for (const spa of STATIC_SPAS) {
  if (/^\s+- key:\s*PORT\s*$/m.test(spa.body)) {
    fail(`[${spa.name}] static service declares PORT envVar — must be removed (CDN-served via env: static, no port to bind)`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 2: every build command must call the shared install wrapper
// (`bash ./scripts/render-install.sh`) AND `pnpm run verify:render`.
// The wrapper is the single source of truth for install flags + the
// stale-`node_modules`-pruning step that defeats Render's build-cache
// orphan-package pollution (the `@types/react@19.1.17` ghost that survived
// across deploys after the catalog bump on 2026-04-28). The wrapper itself
// is verified separately to contain `--frozen-lockfile` and `--prod=false`.
//
// `verify:render` is identical to `verify:production` except it omits
// `typecheck:libs` (`tsc --build`). Render's free-tier build container has
// 512 MB RAM; tsc --build across all workspace libs requires ~354 MB of V8
// heap and OOM-kills the build. Typecheck is run locally and in dedicated CI.
// Either omission of the wrapper or the verify gate would let a deploy
// ship with drift the guardrails are designed to catch.
// ────────────────────────────────────────────────────────────────────────────
const WRAPPER_INVOCATION = /\bbash\s+\.\/scripts\/render-install\.sh\b/;
for (const svc of services.filter((s) => /^temple-tv-(api|admin|web|tv)$/.test(s.name))) {
  const buildBlock = svc.body.match(/buildCommand:\s*\|([\s\S]*?)(?=\n {4}\w|\n {2}- type:|$)/);
  if (!buildBlock) {
    fail(`[${svc.name}] no buildCommand block found`);
    continue;
  }
  const cmd = buildBlock[1];
  if (!WRAPPER_INVOCATION.test(cmd)) {
    fail(`[${svc.name}] buildCommand must call \`bash ./scripts/render-install.sh\` (single source of truth for install flags + stale-node_modules pruning that defeats Render-cache orphan-package pollution — see scripts/render-install.sh header for the full failure-mode history).`);
  }
  if (!/pnpm run verify:render/.test(cmd)) {
    fail(`[${svc.name}] buildCommand missing \`pnpm run verify:render\` (deploy would skip catalog/recharts/types/tsconfig/env-secrets/db-schema guardrails; use verify:render not verify:production — tsc --build OOMs on Render's 512 MB free-tier build containers)`);
  }
}

// Verify the wrapper script itself contains the install flags. This makes
// the wrapper-based indirection safe: the per-service check above asserts
// "you must use the wrapper", and this check asserts "the wrapper must
// contain the right flags" — together they cover the same surface area as
// the previous per-service flag checks.
const WRAPPER_PATH = join(ROOT, "scripts", "render-install.sh");
if (!existsSync(WRAPPER_PATH)) {
  fail(`shared install wrapper missing at ${WRAPPER_PATH} — every service's buildCommand calls it; without it every deploy would fail.`);
} else {
  const wrapperSrc = readFileSync(WRAPPER_PATH, "utf8");
  if (!/--frozen-lockfile/.test(wrapperSrc)) {
    fail(`scripts/render-install.sh missing \`--frozen-lockfile\` (lockfile would be re-resolved → duplicate-package risk)`);
  }
  if (!/--prod=false/.test(wrapperSrc)) {
    fail(`scripts/render-install.sh missing \`--prod=false\` (Render sets NODE_ENV=production by default, so devDependencies like @types/node and vite would be skipped → tsc fails with TS2688)`);
  }
  if (!/rm\s+-rf[\s\S]*?node_modules/.test(wrapperSrc)) {
    fail(`scripts/render-install.sh missing the stale-node_modules pruning step (the whole point of the wrapper — without it, Render's build cache reintroduces orphan packages from previous deploys and the verify:react-types-singleton guardrail trips even though the lockfile is clean)`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 3: api-server must declare a healthCheckPath. Without it
// Render's LB cannot rotate dead pods out, leading to the "502 from one of
// the rotation members" incident class.
// ────────────────────────────────────────────────────────────────────────────
{
  const api = services.find((s) => s.name === "temple-tv-api");
  if (api && !/^\s+healthCheckPath:\s*\/api\/healthz/m.test(api.body)) {
    fail(`[temple-tv-api] healthCheckPath must be set to /api/healthz`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 4: each static SPA MUST declare each of these headers (presence-
// only — values may legitimately differ for X-Frame-Options).
// ────────────────────────────────────────────────────────────────────────────
const REQUIRED_HEADERS = [
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
] as const;

const spaHeaders = new Map<string, HeaderEntry[]>();
for (const spa of STATIC_SPAS) {
  spaHeaders.set(spa.name, extractHeaders(spa.body));
}

for (const spa of STATIC_SPAS) {
  const hdrs = spaHeaders.get(spa.name) ?? [];
  for (const required of REQUIRED_HEADERS) {
    if (!hdrs.find((h) => h.name === required)) {
      fail(`[${spa.name}] missing required security header "${required}"`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 5: HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-
// Policy values MUST be identical across all 3 SPAs. Drift means one SPA
// gets weaker hardening than the other two.
//
// X-Frame-Options is intentionally excluded — admin=DENY vs web/tv=SAMEORIGIN
// is a deliberate posture difference (admin must never be embedded; web/tv
// have legitimate embedding contexts).
// ────────────────────────────────────────────────────────────────────────────
const PARITY_HEADERS = [
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
] as const;

for (const headerName of PARITY_HEADERS) {
  const valuesPerSpa: Array<{ spa: string; value: string }> = [];
  for (const spa of STATIC_SPAS) {
    const h = (spaHeaders.get(spa.name) ?? []).find(
      (e) => e.name === headerName,
    );
    if (h) valuesPerSpa.push({ spa: spa.name, value: h.value });
  }
  const distinct = new Set(valuesPerSpa.map((v) => v.value));
  if (distinct.size > 1) {
    const breakdown = valuesPerSpa
      .map((v) => `${v.spa}="${v.value}"`)
      .join(", ");
    fail(`[SPA-header-parity] "${headerName}" drifts across SPAs: ${breakdown}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 6: HSTS lifetime must be >= 1 year (RFC 6797 + browser preload-
// list submission requirements). 63072000 = 2 years, our chosen value.
// ────────────────────────────────────────────────────────────────────────────
for (const spa of STATIC_SPAS) {
  const hsts = (spaHeaders.get(spa.name) ?? []).find(
    (h) => h.name === "Strict-Transport-Security",
  );
  if (!hsts) continue; // already flagged by invariant 4
  const maxAgeMatch = hsts.value.match(/max-age=(\d+)/);
  if (!maxAgeMatch) {
    fail(`[${spa.name}] HSTS value missing max-age directive: "${hsts.value}"`);
    continue;
  }
  const seconds = parseInt(maxAgeMatch[1], 10);
  const ONE_YEAR = 31536000;
  if (seconds < ONE_YEAR) {
    fail(`[${spa.name}] HSTS max-age=${seconds} is below 1 year (${ONE_YEAR}) — preload-list submission requires >= 1 year`);
  }
  if (!/includeSubDomains/i.test(hsts.value)) {
    fail(`[${spa.name}] HSTS missing includeSubDomains directive`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invariant 7: if COOP is set on any SPA, value must be `same-origin`
// (the only setting that gives full process-level isolation).
// ────────────────────────────────────────────────────────────────────────────
for (const spa of STATIC_SPAS) {
  const coop = (spaHeaders.get(spa.name) ?? []).find(
    (h) => h.name === "Cross-Origin-Opener-Policy",
  );
  if (coop && coop.value !== "same-origin") {
    fail(`[${spa.name}] Cross-Origin-Opener-Policy must be "same-origin" if set (got "${coop.value}")`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Report
// ────────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("[verify:render-yaml] FAIL — render.yaml invariant violations:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nWhy this matters: render.yaml drives every production deploy. A copy-paste\n` +
      `mistake or stale envVar on any one service can ship a real security gap (missing\n` +
      `HSTS, weaker Referrer-Policy on one SPA than the others) or a build-config gap\n` +
      `(missing --frozen-lockfile would let pnpm re-resolve and reintroduce duplicate\n` +
      `package installs, undoing the override fix from Round 9). The 3 static SPAs\n` +
      `(admin, web, tv) MUST agree on Strict-Transport-Security, X-Content-Type-Options,\n` +
      `Referrer-Policy, and Permissions-Policy values. X-Frame-Options legitimately\n` +
      `differs (admin=DENY, web/tv=SAMEORIGIN) but every SPA must declare some value.\n` +
      `Every Node-runtime service must include the full guardrail chain in its build.`,
  );
  process.exit(1);
}

console.log(
  `[verify:render-yaml] OK — ${services.length} services validated (free-tier: api + 3 static SPAs, no paid worker); ${STATIC_SPAS.length}-way SPA security-header parity confirmed; every build command calls scripts/render-install.sh + verify:render (no tsc --build — OOMs on 512 MB free-tier build containers; typecheck runs locally/CI only); wrapper script includes --frozen-lockfile + --prod=false + stale-node_modules pruning; HSTS lifetimes >= 1 year on every SPA.`,
);
