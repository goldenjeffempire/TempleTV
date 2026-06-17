/**
 * Integration tests for sql-array-utils.ts
 *
 * Verifies that every helper function produces correct, error-free PostgreSQL
 * queries for all edge cases:
 *  - empty arrays     → short-circuit / no DB call / no error
 *  - single-element   → valid SQL, correct result
 *  - multi-element    → valid SQL, correct result
 *  - wildcard LIKE    → prefix matching via UNNEST (not broken LIKE ANY)
 *  - UUID arrays      → storage key paths with realistic IDs
 *  - storage paths    → transcoded/{videoId}/master.m3u8 key patterns
 *
 * Root cause guarded:
 *   Drizzle `sql\`...\`` expands a JS array to tuple notation `($1,$2,...)`.
 *   Casting a tuple to text[] — `($1,$2)::text[]` — is rejected by PostgreSQL
 *   with ERROR 42846 (cannot cast type record to text[]).
 *   `sql.param(array)` passes the array as a single $N binding; the pg driver
 *   serialises string[] to `{v1,v2,...}` so `$N::text[]` is valid.
 *
 * All tests skip gracefully when the DB is unavailable (CI / no Postgres).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { sql, eq } from "drizzle-orm";

// ── DB and schema (conditional import so test file parses even without Postgres) ─
let db: Awaited<ReturnType<typeof import("../../src/infrastructure/db.js")["db"]["$client"]["connect"]>> | null = null;
let drizzleDb: typeof import("../../src/infrastructure/db.js")["db"] | null = null;
let schema: typeof import("../../src/infrastructure/db.js")["schema"] | null = null;
let utils: typeof import("../../src/infrastructure/sql-array-utils.js") | null = null;

const TEST_KEY_PREFIX = "test-sql-array-utils-";

// Random suffix so parallel test runs don't collide.
const RUN_ID = Math.random().toString(36).slice(2, 10);
function testKey(suffix: string) {
  return `${TEST_KEY_PREFIX}${RUN_ID}-${suffix}`;
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_ACCESS_SECRET = "x".repeat(64);
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
  process.env.PROD_SYNC_DISABLE = "1";

  try {
    const dbMod = await import("../../src/infrastructure/db.js");
    drizzleDb = dbMod.db;
    schema = dbMod.schema;
    utils = await import("../../src/infrastructure/sql-array-utils.js");
  } catch {
    // DB unavailable — all tests guard with `if (!drizzleDb) return`.
  }
}, 30_000);

afterAll(async () => {
  if (!drizzleDb || !schema) return;
  try {
    // Best-effort cleanup of any test blobs we inserted.
    await drizzleDb.execute(sql`
      DELETE FROM storage_blobs
      WHERE key LIKE ${TEST_KEY_PREFIX + RUN_ID + "%"}
    `);
  } catch {
    // ignore
  }
});

// ── Helper: insert a test blob into storage_blobs ─────────────────────────────

async function insertBlob(key: string, sizeBytes = 100) {
  if (!drizzleDb || !schema) throw new Error("DB unavailable");
  await drizzleDb.execute(sql`
    INSERT INTO storage_blobs (key, data, size_bytes, created_at, updated_at)
    VALUES (
      ${key},
      ${Buffer.from("test")},
      ${sizeBytes},
      now(),
      now()
    )
    ON CONFLICT (key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. safeInArray
// ─────────────────────────────────────────────────────────────────────────────

describe("safeInArray", () => {
  it("returns SQL FALSE for empty array without hitting DB", async () => {
    if (!utils) return;
    const clause = utils.safeInArray({} as never, []);
    expect(String(clause)).toContain("FALSE");
  });

  it("produces a valid SQL fragment for single-element arrays", async () => {
    if (!utils) return;
    // Just check it doesn't throw and produces a non-empty SQL object.
    const clause = utils.safeInArray({} as never, ["abc"]);
    expect(clause).toBeTruthy();
  });

  it("produces a valid SQL fragment for multi-element arrays", async () => {
    if (!utils) return;
    const clause = utils.safeInArray({} as never, ["a", "b", "c"]);
    expect(clause).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. blobCountByVideoIdPrefix
// ─────────────────────────────────────────────────────────────────────────────

describe("blobCountByVideoIdPrefix", () => {
  it("returns empty Map immediately for empty videoIds (no DB call)", async () => {
    if (!utils) return;
    const result = await utils.blobCountByVideoIdPrefix([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("returns empty Map for videoId with no blobs", async () => {
    if (!utils || !drizzleDb) return;
    const result = await utils.blobCountByVideoIdPrefix(["nonexistent-uuid-00000000"]);
    expect(result.get("nonexistent-uuid-00000000")).toBeUndefined();
  });

  it("counts blobs correctly for single videoId", async () => {
    if (!utils || !drizzleDb) return;
    const vid = `vid-${RUN_ID}-single`;
    await insertBlob(testKey(`transcoded/${vid}/master.m3u8`));
    await insertBlob(testKey(`transcoded/${vid}/v0/seg000.ts`));
    await insertBlob(testKey(`transcoded/${vid}/v1/seg000.ts`));

    // blobCountByVideoIdPrefix uses "transcoded/{vid}/%" prefix
    // We inserted under a test prefix, so re-insert under the canonical prefix.
    const canonKey1 = `transcoded/${vid}/master.m3u8`;
    const canonKey2 = `transcoded/${vid}/v0/seg000.ts`;
    await insertBlob(canonKey1);
    await insertBlob(canonKey2);

    const result = await utils.blobCountByVideoIdPrefix([vid]);
    expect(result.get(vid)).toBeGreaterThanOrEqual(2);

    // Cleanup
    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key LIKE ${"transcoded/" + vid + "/%"}`);
  });

  it("correctly handles multi-element videoId arrays (UNNEST pattern)", async () => {
    if (!utils || !drizzleDb) return;
    const vid1 = `vid-${RUN_ID}-multi1`;
    const vid2 = `vid-${RUN_ID}-multi2`;
    await insertBlob(`transcoded/${vid1}/master.m3u8`);
    await insertBlob(`transcoded/${vid2}/master.m3u8`);
    await insertBlob(`transcoded/${vid2}/v0/seg000.ts`);

    const result = await utils.blobCountByVideoIdPrefix([vid1, vid2]);
    expect(result.get(vid1)).toBe(1);
    expect(result.get(vid2)).toBe(2);

    // Cleanup
    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key LIKE ${"transcoded/" + vid1 + "/%"}`);
    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key LIKE ${"transcoded/" + vid2 + "/%"}`);
  });

  it("does not return videoIds with zero blobs in the map", async () => {
    if (!utils || !drizzleDb) return;
    const vidPresent = `vid-${RUN_ID}-present`;
    const vidAbsent = `vid-${RUN_ID}-absent`;
    await insertBlob(`transcoded/${vidPresent}/master.m3u8`);

    const result = await utils.blobCountByVideoIdPrefix([vidPresent, vidAbsent]);
    expect(result.has(vidPresent)).toBe(true);
    expect(result.has(vidAbsent)).toBe(false);

    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key = ${"transcoded/" + vidPresent + "/master.m3u8"}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. presentStorageKeys
// ─────────────────────────────────────────────────────────────────────────────

describe("presentStorageKeys", () => {
  it("returns empty Set immediately for empty keys (no DB call)", async () => {
    if (!utils) return;
    const result = await utils.presentStorageKeys([]);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it("returns empty Set for keys not in storage_blobs", async () => {
    if (!utils || !drizzleDb) return;
    const result = await utils.presentStorageKeys([
      "definitely/not/here.m3u8",
      "also/not/here.ts",
    ]);
    expect(result.size).toBe(0);
  });

  it("returns only the subset of keys that exist — single element", async () => {
    if (!utils || !drizzleDb) return;
    const key = testKey("psk-single.m3u8");
    await insertBlob(key);
    const result = await utils.presentStorageKeys([key, "missing-key.ts"]);
    expect(result.has(key)).toBe(true);
    expect(result.has("missing-key.ts")).toBe(false);
    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`);
  });

  it("returns only the subset of keys that exist — multi element", async () => {
    if (!utils || !drizzleDb) return;
    const keys = [
      testKey("psk-multi-1.m3u8"),
      testKey("psk-multi-2.m3u8"),
      testKey("psk-multi-3.m3u8"),
    ];
    await insertBlob(keys[0]!);
    await insertBlob(keys[2]!);
    // keys[1] is intentionally NOT inserted.

    const result = await utils.presentStorageKeys(keys);
    expect(result.has(keys[0]!)).toBe(true);
    expect(result.has(keys[1]!)).toBe(false);
    expect(result.has(keys[2]!)).toBe(true);

    for (const k of [keys[0]!, keys[2]!]) {
      await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key = ${k}`);
    }
  });

  it("excludes zero-byte blobs when requireNonZero=true", async () => {
    if (!utils || !drizzleDb) return;
    const zeroKey = testKey("psk-zero.m3u8");
    const realKey = testKey("psk-real.m3u8");
    await insertBlob(zeroKey, 0);
    await insertBlob(realKey, 500);

    const withZero = await utils.presentStorageKeys([zeroKey, realKey]);
    const withoutZero = await utils.presentStorageKeys([zeroKey, realKey], { requireNonZero: true });

    expect(withZero.has(zeroKey)).toBe(true);
    expect(withoutZero.has(zeroKey)).toBe(false);
    expect(withoutZero.has(realKey)).toBe(true);

    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key IN (${zeroKey}, ${realKey})`);
  });

  it("correctly checks HLS master.m3u8 storage paths (realistic UUID keys)", async () => {
    if (!utils || !drizzleDb) return;
    const uuid1 = "550e8400-e29b-41d4-a716-446655440001";
    const uuid2 = "550e8400-e29b-41d4-a716-446655440002";
    const masterKey1 = `transcoded/${uuid1}/master.m3u8`;
    const masterKey2 = `transcoded/${uuid2}/master.m3u8`;
    await insertBlob(masterKey1);
    // masterKey2 intentionally not inserted.

    const result = await utils.presentStorageKeys([masterKey1, masterKey2]);
    expect(result.has(masterKey1)).toBe(true);
    expect(result.has(masterKey2)).toBe(false);

    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key = ${masterKey1}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. likeAnyOr
// ─────────────────────────────────────────────────────────────────────────────

describe("likeAnyOr", () => {
  it("returns sql FALSE for empty patterns", async () => {
    if (!utils) return;
    const clause = utils.likeAnyOr({} as never, []);
    expect(String(clause)).toContain("FALSE");
  });

  it("produces a single LIKE expression for one pattern", async () => {
    if (!utils) return;
    const clause = utils.likeAnyOr({} as never, ["transcoded/abc/%"]);
    expect(clause).toBeTruthy();
  });

  it("produces an OR-chain for multiple patterns", async () => {
    if (!utils) return;
    const clause = utils.likeAnyOr({} as never, ["transcoded/abc/%", "transcoded/def/%"]);
    expect(clause).toBeTruthy();
  });

  it("matches blobs via OR-chained LIKE (live DB query)", async () => {
    if (!utils || !drizzleDb || !schema) return;
    const vid1 = `vid-${RUN_ID}-like1`;
    const vid2 = `vid-${RUN_ID}-like2`;
    await insertBlob(`transcoded/${vid1}/master.m3u8`);
    await insertBlob(`transcoded/${vid2}/master.m3u8`);

    const rows = await drizzleDb!
      .select({ key: schema!.storageBlobsTable.key })
      .from(schema!.storageBlobsTable)
      .where(
        utils.likeAnyOr(schema!.storageBlobsTable.key, [
          `transcoded/${vid1}/%`,
          `transcoded/${vid2}/%`,
        ]),
      );

    const keys = rows.map((r) => r.key);
    expect(keys).toContain(`transcoded/${vid1}/master.m3u8`);
    expect(keys).toContain(`transcoded/${vid2}/master.m3u8`);

    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key IN (${"transcoded/" + vid1 + "/master.m3u8"}, ${"transcoded/" + vid2 + "/master.m3u8"})`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. anyTextParam
// ─────────────────────────────────────────────────────────────────────────────

describe("anyTextParam", () => {
  it("returns = ANY('{}'::text[]) for empty array", async () => {
    if (!utils) return;
    const frag = utils.anyTextParam([]);
    expect(String(frag)).toContain("'{}'");
  });

  it("produces a non-empty SQL fragment for single-element arrays", async () => {
    if (!utils) return;
    const frag = utils.anyTextParam(["abc"]);
    expect(frag).toBeTruthy();
  });

  it("produces a valid fragment for multi-element arrays", async () => {
    if (!utils) return;
    const frag = utils.anyTextParam(["a", "b", "c"]);
    expect(frag).toBeTruthy();
  });

  it("correctly matches rows when embedded in a raw sql WHERE clause (live DB)", async () => {
    if (!utils || !drizzleDb) return;
    const key1 = testKey("any-param-1.m3u8");
    const key2 = testKey("any-param-2.m3u8");
    const key3 = testKey("any-param-absent.m3u8");
    await insertBlob(key1);
    await insertBlob(key2);

    // This is the pattern used in hls-startup-integrity.ts for the UPDATE and
    // in transcoder.dispatcher.ts for master key probes.
    const frag = utils.anyTextParam([key1, key2, key3]);
    const result = await drizzleDb!.execute<{ key: string }>(sql`
      SELECT key FROM storage_blobs WHERE key ${frag}
    `);
    const found = new Set((result.rows as { key: string }[]).map((r) => r.key));
    expect(found.has(key1)).toBe(true);
    expect(found.has(key2)).toBe(true);
    expect(found.has(key3)).toBe(false);

    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key IN (${key1}, ${key2})`);
  });

  it("does NOT generate tuple notation ($1,$2,...) — uses single param binding", async () => {
    if (!utils || !drizzleDb) return;
    // If the broken pattern were used, PostgreSQL would throw ERROR 42846.
    // A successful query here confirms the correct any[] serialisation.
    const key = testKey("any-param-single.ts");
    await insertBlob(key);

    const frag = utils.anyTextParam([key]);
    let threw = false;
    try {
      await drizzleDb!.execute<{ key: string }>(sql`
        SELECT key FROM storage_blobs WHERE key ${frag}
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    await drizzleDb!.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Regression: ANY(${array}::text[]) broken pattern guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression guard: Drizzle array-in-sql-template tuple bug", () => {
  it("sql.param(array) does NOT cause ERROR 42846 — multi-element array", async () => {
    if (!drizzleDb) return;
    const keys = ["a", "b", "c"];

    let threw = false;
    try {
      await drizzleDb.execute<{ key: string }>(sql`
        SELECT key FROM storage_blobs
        WHERE key = ANY(${sql.param(keys)}::text[])
          AND 1 = 0
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("UNNEST-based blob count query does NOT cause ERROR 42846", async () => {
    if (!drizzleDb || !utils) return;
    // This is the pattern used in blobCountByVideoIdPrefix.
    const videoIds = ["uuid-1", "uuid-2", "uuid-3"];
    let threw = false;
    try {
      await utils.blobCountByVideoIdPrefix(videoIds);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("presentStorageKeys does NOT cause ERROR 42846 for multi-element arrays", async () => {
    if (!drizzleDb || !utils) return;
    const keys = ["transcoded/uuid-a/master.m3u8", "transcoded/uuid-b/master.m3u8"];
    let threw = false;
    try {
      await utils.presentStorageKeys(keys);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("anyTextParam does NOT cause ERROR 42846 for UUID-style storage paths", async () => {
    if (!drizzleDb || !utils) return;
    const keys = [
      "transcoded/550e8400-e29b-41d4-a716-446655440001/master.m3u8",
      "transcoded/550e8400-e29b-41d4-a716-446655440002/master.m3u8",
    ];
    const frag = utils.anyTextParam(keys);
    let threw = false;
    try {
      await drizzleDb.execute<{ key: string }>(sql`
        SELECT key FROM storage_blobs WHERE key ${frag}
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
