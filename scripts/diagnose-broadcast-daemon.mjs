// Run in the Render daemon Shell: node scripts/diagnose-broadcast-daemon.mjs
// Read-only diagnostic: no imports of app startup, no lock or session mutation.
import { createRequire } from "node:module";
const load = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Client } = load("pg");
const deadline = setTimeout(() => {
  console.error("Diagnostic timed out. No locks or other sessions were changed.");
  process.exit(1);
}, 20_000);
let connection = null;
try {
  connection = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
} catch {
  console.error("Invalid database connection configuration (value not disclosed).");
  process.exit(1);
}
if (connection && ["prefer", "require", "verify-ca"].includes(connection.searchParams.get("sslmode"))) {
  connection.searchParams.set("sslmode", "verify-full");
}
const client = new Client({
  connectionString: connection?.toString(),
  application_name: "broadcast-readonly-diagnostic",
  connectionTimeoutMillis: 5000, query_timeout: 6000,
});
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  try {
    const port = Number(process.env.PORT || 9000);
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(3000),
    });
    console.log("Local readiness:", response.status, await response.text());
  } catch {
    console.log("Local readiness: no response within 3 seconds");
  }
  await client.connect();
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '5s'");
  const result = await client.query(`
    SELECT l.pid, l.granted, a.application_name, a.state,
           a.backend_start, a.xact_start, a.wait_event_type, a.wait_event
    FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory'
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.classid = ($1::bigint >> 32)::oid
      AND l.objid = ($1::bigint & 4294967295)::oid AND l.objsubid = 1
    ORDER BY l.granted DESC, l.pid
  `, ["7878787878"]);
  console.log("Broadcast lock sessions:", JSON.stringify(result.rows, null, 2));
  await client.query("ROLLBACK");
} catch (error) {
  console.error("Diagnostic failed:", error.code || error.name);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  clearTimeout(deadline);
}
