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
import { type SQL, type Column } from "drizzle-orm";
/**
 * Wraps Drizzle `inArray()` with an explicit empty-array short-circuit.
 *
 * Drizzle 0.45.x already generates `false` for `inArray(col, [])`, but this
 * wrapper makes the intent explicit and guards against regressions on library
 * upgrades where that behaviour might change.
 *
 * @example `.where(safeInArray(table.id, ids))`
 */
export declare function safeInArray<T>(col: Column, values: T[]): SQL;
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
export declare function blobCountByVideoIdPrefix(videoIds: string[]): Promise<Map<string, number>>;
/**
 * Returns the Set of keys from `storage_blobs` that exist for the supplied key
 * list.  Returns an empty Set immediately when `keys` is empty (no DB query).
 *
 * Uses Drizzle `inArray()` which generates valid `IN ($1, $2, ...)` SQL.
 * Pass `requireNonZero: true` to exclude zero-byte (corrupt/interrupted) blobs.
 */
export declare function presentStorageKeys(keys: string[], opts?: {
    requireNonZero?: boolean;
}): Promise<Set<string>>;
/**
 * Builds an OR-chain of `col LIKE pattern` expressions.
 * Safe alternative to `LIKE ANY()` for small pattern lists.
 *
 * Returns `sql\`FALSE\`` for an empty patterns array.
 *
 * @example `.where(likeAnyOr(table.key, ['transcoded/abc/%', 'transcoded/def/%']))`
 */
export declare function likeAnyOr(col: Column, patterns: string[]): SQL;
/**
 * Produces a SQL fragment `= ANY($N::text[])` that is safe for use inside a
 * Drizzle `sql\`...\`` template.
 *
 * **Why this is needed:**
 * Drizzle's `sql\`...\`` template expands a plain JS array to a tuple literal
 * `($1, $2, ...)`.  Casting a tuple to `text[]` — `($1, $2)::text[]` — is
 * rejected by PostgreSQL with ERROR 42846 (cannot cast type record to text[]).
 *
 * `sql.param(values)` passes the entire array as a *single* `$N` binding.
 * The `pg` driver then serialises `string[]` as the PostgreSQL array literal
 * `{v1,v2,...}`, so `$N::text[]` is valid.
 *
 * Returns `sql\`= ANY('{}'::text[])\`` (matches nothing) for an empty array.
 *
 * @example
 *   await db.execute(sql`
 *     UPDATE foo SET bar = true
 *     WHERE id ${anyTextParam(ids)}
 *   `);
 */
export declare function anyTextParam(values: string[]): SQL;
