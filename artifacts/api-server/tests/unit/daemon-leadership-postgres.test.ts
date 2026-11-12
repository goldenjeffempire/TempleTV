import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withDaemonDeadline } from "../../src/infrastructure/daemon-startup-guard.js";

// Opt-in against the development PG* database only. Never use DATABASE_URL,
// which may refer to an unrelated external/production database.
test("PostgreSQL fences contenders and hands leadership over after connection loss", {
  skip: process.env.RUN_DAEMON_DB_TESTS !== "1",
}, async () => {
  assert.equal(process.env.NODE_ENV, "development");
  assert.ok(process.env.PGHOST && process.env.PGDATABASE);
  const pool = new pg.Pool({
    host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER, password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE, max: 3, connectionTimeoutMillis: 3000,
    application_name: "temple-daemon-regression-test",
  });
  const leader = await pool.connect();
  const contender = await pool.connect();
  let leaderDestroyed = false;
  // A fresh test key, NEVER the actual broadcast leadership key.
  const key = String(2_000_000_000 + process.pid);
  try {
    await leader.query("BEGIN");
    await contender.query("BEGIN");
    await leader.query("SET LOCAL statement_timeout = '1s'");
    await contender.query("SET LOCAL statement_timeout = '1s'");
    const attempt = async (client: pg.PoolClient) => {
      const result = await withDaemonDeadline(client.query(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired", [key],
      ), "test lock", 2000);
      return result.rows[0].acquired;
    };
    assert.equal(await attempt(leader), true);
    assert.equal(await attempt(contender), false);
    // Destroy only our test connection, simulating daemon network loss.
    leader.release(true);
    leaderDestroyed = true;
    let acquired = false;
    const until = Date.now() + 3000;
    while (!acquired && Date.now() < until) {
      acquired = await attempt(contender);
      if (!acquired) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(acquired, true);
    await contender.query("ROLLBACK");
    const follower = await pool.connect();
    try {
      await follower.query("BEGIN");
      assert.equal(await attempt(follower), true);
      await follower.query("ROLLBACK");
    } finally { follower.release(true); }
  } finally {
    if (!leaderDestroyed) leader.release(true);
    contender.release(true);
    await pool.end();
  }
});
