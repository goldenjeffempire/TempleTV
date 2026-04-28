#!/usr/bin/env tsx
/**
 * verify:env-secrets
 *
 * Asserts cross-service invariants on `render.yaml`'s envVar declarations so
 * that a single typo, a copy-paste, or a well-meaning convenience edit can
 * never (a) ship a hard-coded credential, (b) leak a secret into a client
 * bundle, (c) leave a service silently missing required env vars at runtime,
 * or (d) accumulate dead environment-group config that drifts out of sync
 * with what's actually wired up in the Render dashboard.
 *
 * Why this is worth a dedicated guardrail (history & reasoning):
 *   - render.yaml declares 2 envVarGroups (`temple-tv-aws`,
 *     `temple-tv-shared-secrets`) populated ONCE in the Render dashboard,
 *     and every service that needs those credentials inherits via
 *     `fromGroup: <name>`. The historical incident this replaces:
 *     "Refusing to start (role=worker): AWS S3 is required" — the worker
 *     was missing AWS_* mirrored vars because someone added them to the
 *     api-server's per-service envVars block but forgot to mirror them on
 *     the worker. The envGroup pattern fixes that — but only if every
 *     `fromGroup:` reference actually resolves to a declared group. A typo
 *     like `temple-tv-aws-creds` (when the group is named `temple-tv-aws`)
 *     would silently leave the worker without credentials, exactly
 *     reproducing the original incident.
 *
 *   - Secret-shaped keys declared on a STATIC SPA service get baked into
 *     the production JS bundle by Vite at build time and shipped to every
 *     end-user browser. Adding `JWT_SECRET` or `STRIPE_SECRET_KEY` to the
 *     admin/web/tv envVars block — directly OR via fromGroup of a group
 *     that contains those keys — is a CATASTROPHIC credential leak that
 *     would land the secret in a public CDN with permanent edge caching.
 *     This guardrail forbids it structurally so it's literally impossible
 *     to ship that bug.
 *
 *   - A secret declared with a literal `value:` (instead of `sync: false`
 *     or via group) means the secret is committed to git in plaintext. We
 *     forbid that at the file-parse level so a sleep-deprived operator
 *     can't accidentally do it during an incident.
 *
 *   - Dead envVarGroups (declared but never referenced) accumulate over
 *     time, drift from what's actually populated in the dashboard, and
 *     mislead the next operator into thinking some service inherits
 *     credentials that nothing actually inherits. We flag them so the
 *     yaml stays an accurate map of reality.
 *
 *   - Duplicate envVar keys within a single service (one direct, one via
 *     group, or two directs) create a Render-resolution-order ambiguity.
 *     Render's documented behavior is "service-level wins over group" but
 *     relying on that is brittle; better to have exactly one source of
 *     truth per (service, key) pair.
 *
 * What's deliberately NOT enforced:
 *   - "Code reads process.env.X but render.yaml doesn't declare X for that
 *     service" — too noisy. The codebase legitimately has many optional
 *     env-var knobs (LIVE_INGEST_*, MAX_SSE_*, LOG_LEVEL, RATE_LIMIT_*)
 *     with documented defaults that are INTENDED to be unset in production
 *     until an operator decides to override. Flagging all of them would
 *     create alarm fatigue.
 *   - SENTRY_DSN matching the secret-shape pattern — Sentry DSNs are
 *     publishable tokens (designed to be embedded in client code; their
 *     security model is rate limiting + project-scoped event ingestion,
 *     not secrecy). We explicitly allowlist `*_DSN`.
 *   - VAPID_PUBLIC_KEY ending in `_KEY` — public keys are public by
 *     definition. We match `_PRIVATE_KEY` and `_SECRET_KEY` specifically.
 *   - VITE_* / EXPO_PUBLIC_* prefixes on static SPAs — these are the
 *     framework-blessed convention for vars that ARE intended to be in
 *     the client bundle (API URLs, feature flags, public IDs). Allowlisted.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RENDER_YAML_PATH = join(ROOT, "render.yaml");

if (!existsSync(RENDER_YAML_PATH)) {
  console.error(
    `[verify:env-secrets] FAIL — render.yaml not found at ${RENDER_YAML_PATH}`,
  );
  process.exit(1);
}

const src = readFileSync(RENDER_YAML_PATH, "utf8");

// ────────────────────────────────────────────────────────────────────────────
// Secret-shape detection. A key is "secret-shaped" if leaking it would
// compromise production. Conservative deny-list with explicit allow-list
// for known-safe patterns (public keys, framework-public prefixes, DSNs).
// ────────────────────────────────────────────────────────────────────────────
const SECRET_SUFFIXES = [
  "_SECRET",
  "_PASSWORD",
  "_PRIVATE_KEY",
  "_SECRET_KEY",
  "_SECRET_ACCESS_KEY",
];
const SECRET_EXACT = new Set([
  "DATABASE_URL", // postgres connection string with password
  "REDIS_URL", // redis connection string with password
  "JWT_SECRET",
  "AWS_ACCESS_KEY_ID", // pairs with AWS_SECRET_ACCESS_KEY; both must be hidden
  "AWS_SECRET_ACCESS_KEY",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "ENCRYPTION_KEY",
]);
// Tokens are secrets, but we exempt anything with PUBLIC in the name (operator
// intent that this token is meant to be embedded — e.g. publishable Stripe
// keys, public webhook IDs). _DSN is also exempt (Sentry DSN is public).
function isSecretShaped(key: string): boolean {
  if (key.includes("PUBLIC")) return false;
  if (key.endsWith("_DSN")) return false;
  if (key.endsWith("_PUBLIC_KEY")) return false;
  if (SECRET_EXACT.has(key)) return true;
  if (key.endsWith("_TOKEN") && !key.startsWith("VITE_")) return true;
  for (const suffix of SECRET_SUFFIXES) {
    if (key.endsWith(suffix)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Static-SPA build-time conventions. Vite (`VITE_*`) and Expo
// (`EXPO_PUBLIC_*`) explicitly designate these prefixes as "intentionally
// inlined into the client bundle." Operator opting-in to this prefix on a
// static service is informed consent that the value is public.
// ────────────────────────────────────────────────────────────────────────────
function isClientPublicPrefix(key: string): boolean {
  return key.startsWith("VITE_") || key.startsWith("EXPO_PUBLIC_");
}

// ────────────────────────────────────────────────────────────────────────────
// envVarGroup parser — slices the top-level `envVarGroups:` block.
// ────────────────────────────────────────────────────────────────────────────
interface EnvGroup {
  name: string;
  keys: string[];
}

function parseEnvGroups(text: string): EnvGroup[] {
  const lines = text.split("\n");
  let inGroups = false;
  const groups: EnvGroup[] = [];
  let current: EnvGroup | null = null;

  for (const line of lines) {
    if (/^envVarGroups:\s*$/.test(line)) {
      inGroups = true;
      continue;
    }
    if (!inGroups) continue;
    // Top-level key (no leading indent) ends the envVarGroups block.
    if (/^[a-zA-Z]/.test(line)) {
      if (current) groups.push(current);
      current = null;
      inGroups = false;
      continue;
    }
    // New group entry: `  - name: temple-tv-aws`
    const nameMatch = line.match(/^\s{2}- name:\s*(\S+)/);
    if (nameMatch) {
      if (current) groups.push(current);
      current = { name: nameMatch[1], keys: [] };
      continue;
    }
    // Keys nested under the group: `      - key: AWS_S3_BUCKET`
    const keyMatch = line.match(/^\s{6}- key:\s*(\S+)/);
    if (keyMatch && current) {
      current.keys.push(keyMatch[1]);
    }
  }
  if (current) groups.push(current);
  return groups;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-service envVars parser.
// ────────────────────────────────────────────────────────────────────────────
interface ServiceEnvBlock {
  name: string;
  runtime: string;
  isStatic: boolean;
  directKeys: { key: string; hasLiteralValue: boolean; lineNo: number }[];
  fromGroupRefs: string[];
}

function parseServices(text: string): ServiceEnvBlock[] {
  const lines = text.split("\n");
  const services: ServiceEnvBlock[] = [];

  // Slice the document into per-service regions. A service starts at
  // `  - type: web` or `  - type: worker` (2-space indent) and runs until
  // the next 2-space `  - type:`.
  const serviceStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{2}- type:\s+\S+/.test(lines[i])) serviceStarts.push(i);
  }
  // Cap with end-of-file so the last service has a bound.
  serviceStarts.push(lines.length);

  for (let s = 0; s < serviceStarts.length - 1; s++) {
    const start = serviceStarts[s];
    const end = serviceStarts[s + 1];
    const block = lines.slice(start, end);
    const nameMatch = block.join("\n").match(/^\s{4}name:\s*(\S+)/m);
    const runtimeMatch = block.join("\n").match(/^\s{4}runtime:\s*(\S+)/m);
    if (!nameMatch || !runtimeMatch) continue;

    const svc: ServiceEnvBlock = {
      name: nameMatch[1],
      runtime: runtimeMatch[1],
      isStatic: runtimeMatch[1] === "static",
      directKeys: [],
      fromGroupRefs: [],
    };

    // Find the `envVars:` block within this service. envVars items live at
    // 6-space indent (`      - key: …` or `      - fromGroup: …`).
    let inEnvVars = false;
    for (let i = 0; i < block.length; i++) {
      const line = block[i];
      if (/^\s{4}envVars:\s*$/.test(line)) {
        inEnvVars = true;
        continue;
      }
      if (inEnvVars) {
        // 4-space-indent key (sibling of envVars:) ends the block.
        if (/^\s{4}\S/.test(line)) {
          inEnvVars = false;
          continue;
        }
        const fromGroup = line.match(/^\s{6}- fromGroup:\s*(\S+)/);
        if (fromGroup) {
          svc.fromGroupRefs.push(fromGroup[1]);
          continue;
        }
        const keyMatch = line.match(/^\s{6}- key:\s*(\S+)/);
        if (keyMatch) {
          // Look ahead a few lines for `value:` vs `sync: false` to determine
          // if this key has a literal committed value.
          let hasLiteralValue = false;
          for (let j = i + 1; j < Math.min(i + 6, block.length); j++) {
            if (/^\s{6}- /.test(block[j])) break; // next list item
            if (/^\s{4}\S/.test(block[j])) break; // out of envVars
            if (/^\s{8}value:\s*/.test(block[j])) {
              hasLiteralValue = true;
              break;
            }
            if (/^\s{8}sync:\s*false/.test(block[j])) break;
          }
          svc.directKeys.push({
            key: keyMatch[1],
            hasLiteralValue,
            lineNo: start + i + 1,
          });
        }
      }
    }
    services.push(svc);
  }
  return services;
}

// ────────────────────────────────────────────────────────────────────────────
// Run validations.
// ────────────────────────────────────────────────────────────────────────────
const groups = parseEnvGroups(src);
const services = parseServices(src);
const errors: string[] = [];

// Build group-name index for fast lookup.
const groupByName = new Map<string, EnvGroup>();
for (const g of groups) groupByName.set(g.name, g);

// Track which groups were referenced (for dead-config detection).
const referencedGroups = new Set<string>();

for (const svc of services) {
  // ── Invariant 1: every fromGroup ref must resolve to a declared group.
  for (const ref of svc.fromGroupRefs) {
    if (!groupByName.has(ref)) {
      errors.push(
        `[${svc.name}] fromGroup: "${ref}" — no envVarGroup with that name is declared (typo or stale reference; valid groups: ${groups.map((g) => g.name).join(", ") || "<none>"})`,
      );
    } else {
      referencedGroups.add(ref);
    }
  }

  // ── Invariant 3: no duplicate envVar key within a single service
  // (counting both direct declarations AND keys inherited from groups).
  const seen = new Map<string, string>(); // key → source ("direct" or group name)
  for (const dk of svc.directKeys) {
    if (seen.has(dk.key)) {
      errors.push(
        `[${svc.name}] envVar key "${dk.key}" declared more than once (sources: direct + ${seen.get(dk.key)}) — Render's resolution order is undefined; remove one source`,
      );
    } else {
      seen.set(dk.key, "direct");
    }
  }
  for (const ref of svc.fromGroupRefs) {
    const g = groupByName.get(ref);
    if (!g) continue; // already errored above
    for (const k of g.keys) {
      if (seen.has(k)) {
        errors.push(
          `[${svc.name}] envVar key "${k}" inherited from group "${ref}" but ALSO declared via ${seen.get(k)} — pick one source of truth`,
        );
      } else {
        seen.set(k, `group:${ref}`);
      }
    }
  }

  // ── Invariant 4: no secret-shaped key may be declared with a literal
  // `value:` — must be `sync: false` (set in dashboard) or via group.
  for (const dk of svc.directKeys) {
    if (isSecretShaped(dk.key) && dk.hasLiteralValue) {
      errors.push(
        `[${svc.name}] secret-shaped envVar "${dk.key}" declared with literal \`value:\` at render.yaml:${dk.lineNo} — secrets MUST use \`sync: false\` (operator-set in Render dashboard) or come via fromGroup, never a committed value`,
      );
    }
  }

  // ── Invariant 5: static SPA services may not reference any secret-shaped
  // key — directly OR via a fromGroup that contains one. Static services
  // bake their envVars into the client bundle at Vite/Expo build time.
  if (svc.isStatic) {
    for (const dk of svc.directKeys) {
      if (isSecretShaped(dk.key) && !isClientPublicPrefix(dk.key)) {
        errors.push(
          `[${svc.name}] STATIC SPA declares secret-shaped envVar "${dk.key}" at render.yaml:${dk.lineNo} — would be inlined into the production JS bundle and shipped to every browser. Static services may only declare VITE_*, EXPO_PUBLIC_*, or non-secret values.`,
        );
      }
    }
    for (const ref of svc.fromGroupRefs) {
      const g = groupByName.get(ref);
      if (!g) continue;
      const leaked = g.keys.filter(
        (k) => isSecretShaped(k) && !isClientPublicPrefix(k),
      );
      if (leaked.length > 0) {
        errors.push(
          `[${svc.name}] STATIC SPA inherits envVarGroup "${ref}" which contains secret-shaped key(s): ${leaked.join(", ")} — these would be baked into the client bundle and leaked publicly. Move SPA-required public values into a separate non-secret group, or declare them per-service with VITE_*/EXPO_PUBLIC_* prefixes.`,
        );
      }
    }
  }
}

// ── Invariant 2: every declared envVarGroup must be referenced by ≥1
// service (otherwise it's dead config that drifts out of sync with the
// dashboard). Run AFTER all services are processed.
for (const g of groups) {
  if (!referencedGroups.has(g.name)) {
    errors.push(
      `envVarGroup "${g.name}" is declared with ${g.keys.length} key(s) but no service references it via \`fromGroup: ${g.name}\` — dead config; either wire it up or remove it`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Report.
// ────────────────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error(
    `[verify:env-secrets] FAIL — ${errors.length} envVar invariant violation(s):`,
  );
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\nWhy this matters:\n  - A bad fromGroup ref leaves the service silently missing credentials at\n    runtime (reproduces the historical "AWS S3 is required" worker crash loop).\n  - A secret-shaped key on a static SPA gets baked into the public JS bundle\n    by Vite/Expo at build time and shipped to every browser via CDN — a\n    catastrophic credential leak with permanent edge caching.\n  - A literal \`value:\` for a secret-shaped key commits the secret to git in\n    plaintext.\n  - Dead envVarGroups drift out of sync with what's actually wired in the\n    Render dashboard and mislead the next operator.\n\nFix the violation(s) above and re-run \`pnpm run verify:env-secrets\`.`,
  );
  process.exit(1);
}

const totalKeys = services.reduce((acc, s) => acc + s.directKeys.length, 0);
const totalRefs = services.reduce((acc, s) => acc + s.fromGroupRefs.length, 0);
console.log(
  `[verify:env-secrets] OK — ${services.length} service(s), ${groups.length} envVarGroup(s), ${totalKeys} direct envVar(s), ${totalRefs} fromGroup reference(s); every group is referenced, every reference resolves, no secret-shaped key is committed in plaintext or exposed to a static SPA bundle.`,
);
