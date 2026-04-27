import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Normalize the SSL mode in the connection string so behavior stays stable
 * across pg / pg-connection-string major-version bumps.
 *
 * Current pg-connection-string (v2.x) treats `prefer`, `require`, and
 * `verify-ca` as ALIASES for `verify-full` — every connection that names
 * any of those modes today is in fact running with full CA + hostname
 * verification (the strongest mode). pg-connection-string v3.0.0 / pg v9.0.0
 * will switch those modes to libpq semantics, which are WEAKER (`require`
 * encrypts but does not verify the CA, `prefer` allows unencrypted, etc.),
 * and pg currently emits a `SECURITY WARNING` on every boot to flag the
 * coming change.
 *
 * Rewriting the mode to `verify-full` here:
 *   1. Preserves the EXACT security level the connection has today
 *      (no behavioral change — Neon and Render Postgres both accept
 *      verify-full because they ship valid CA-chained certificates).
 *   2. Silences the boot-time warning so the production log stream isn't
 *      polluted by a forward-compat notice on every worker restart.
 *   3. Future-proofs the deploy: when pg v9 ships, this code keeps the
 *      same behavior automatically.
 */
function normalizeDatabaseUrl(raw: string): string {
  // Skip non-URL connection strings (e.g. KV-style "host=... user=..."), which
  // don't have URL search params and don't trigger the warning anyway.
  if (!/^postgres(ql)?:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const mode = url.searchParams.get("sslmode");
    if (mode === "prefer" || mode === "require" || mode === "verify-ca") {
      url.searchParams.set("sslmode", "verify-full");
      return url.toString();
    }
    return raw;
  } catch {
    // Malformed URL — let the pg client surface the real error rather than
    // masking it with a rewrite attempt.
    return raw;
  }
}

const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export * from "./schema";
