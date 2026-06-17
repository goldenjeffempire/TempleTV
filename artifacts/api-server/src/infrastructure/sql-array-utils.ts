/**
 * Centralized safe SQL array query utilities.
 *
 * Background: Drizzle ORM 0.45.x `PgDialect.sqlToQuery()` expands a plain JS
 * array interpolated inside `sql\`...\`` into a tuple `($1, $2, $3)`.  Casting
 * a row-constructor to a typed array — `($1, $2)::text[]` — is rejected by
 * PostgreSQL with ERROR 42846 (cannot cast type record to text[]).
 *
 * Passing the array through `sql.param()` instead generates a single `$N`
 * binding whose value is the JS array; the `pg` driver serialises `string[]` to
 * the PostgreSQL array literal `{v1,v2,...}` so `$1::text[]` is valid.
 *
 * Rules enforced here:
 *  1. Never use `sql\`${jsArray}::sometype[]\`` — always use `sql.param()`.
 *  2. Drizzle `inArray(col, [])` already generates `WHERE false`, but these
 *     helpers skip the DB call entirely for empty inputs for clarity and speed.
 *  3. `LIKE ANY` has no Drizzle equivalent — use UNNEST + LEFT JOIN instead.
 */
import { sql, inArray, or, like, type SQL, type Column } from "drizzle-orm";
import { db, schema } from "./db.js";

// ─── 1. Safe inArray wrapper ──────────────────────────────────────────────────

/**
 * Wraps Drizzle `inArray()` with an explicit empty-array short-circuit.
 *
 * Drizzle 0.45.x already generates `false` for `inArray(col, [])`, but this
 * wrapper makes the intent explicit and guards against regressions on library
 * upgrades where that behaviour might change.
 *
 * @example `.where(safeInArray(table.id, ids))`
 */
export function safeInArray<T>(col: Column, values: T[]): SQL {
  if (values.length === 0) return sql`FALSE`;
  return inArray(col, values) as unknown as SQL;
}

// ─── 2. Blob prefix count via UNNEST ─────────────────────────────────────────

/**
 * Counts storage_blobs per `transcoded/{videoId}/` prefix for each videoId.
 *
 * Replaces the broken `LIKE ANY(${patterns}::text[])` pattern.  Drizzle would
 * expand a JS array in the sql template to `($1, $2)` (tuple notation), making
 * `ANY(($1, $2)::text[])` invalid PostgreSQL (ERROR 42846).
 *
 * `sql.param(arr)` passes the entire array as a single `$N` binding; the pg
 * driver serialises JS `string[]` to `{v1,v2,...}` so `$1::text[]` is valid.
 *
 * Returns an empty Map when `videoIds` is empty (no DB round-trip).
 */
export async function blobCountByVideoIdPrefix(
  videoIds: string[],
): Promise<Map<string, number>> {
  if (videoIds.length === 0) return new Map();

  type Row = { videoId: string; blobCount: string | number };

  const result = await db.execute<Row>(sql`
    WITH vids(vid) AS (
      SELECT unnest(${sql.param(videoIds)}::text[])
    )
    SELECT
      vids.vid              AS "videoId",
      COUNT(sb.key)::bigint AS "blobCount"
    FROM vids
    LEFT JOIN storage_blobs sb
           ON sb.key LIKE ('transcoded/' || vids.vid || '/%')
    GROUP BY vids.vid
    HAVING COUNT(sb.key) > 0
  `);

  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.videoId, Number(row.blobCount));
  }
  return map;
}

// ─── 3. Safe storage blob presence check ─────────────────────────────────────

/**
 * Returns the Set of keys from `storage_blobs` that exist for the supplied key
 * list.  Returns an empty Set immediately when `keys` is empty (no DB query).
 *
 * Uses Drizzle `inArray()` which generates valid `IN ($1, $2, ...)` SQL.
 * Pass `requireNonZero: true` to exclude zero-byte (corrupt/interrupted) blobs.
 */
export async function presentStorageKeys(
  keys: string[],
  opts: { requireNonZero?: boolean } = {},
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  const { requireNonZero = false } = opts;

  const baseWhere = inArray(schema.storageBlobsTable.key, keys);
  const whereClause = requireNonZero
    ? sql`${baseWhere} AND ${schema.storageBlobsTable.sizeBytes} > 0`
    : baseWhere;

  const rows = await db
    .select({ key: schema.storageBlobsTable.key })
    .from(schema.storageBlobsTable)
    .where(whereClause as SQL);

  return new Set(rows.map((r) => r.key));
}

// ─── 4. OR-based LIKE helper ─────────────────────────────────────────────────

/**
 * Builds an OR-chain of `col LIKE pattern` expressions.
 * Safe alternative to `LIKE ANY()` for small pattern lists.
 *
 * Returns `sql\`FALSE\`` for an empty patterns array.
 *
 * @example `.where(likeAnyOr(table.key, ['transcoded/abc/%', 'transcoded/def/%']))`
 */
export function likeAnyOr(col: Column, patterns: string[]): SQL {
  if (patterns.length === 0) return sql`FALSE`;
  if (patterns.length === 1) return like(col, patterns[0]!) as unknown as SQL;
  return or(...patterns.map((p) => like(col, p))) as unknown as SQL;
}
