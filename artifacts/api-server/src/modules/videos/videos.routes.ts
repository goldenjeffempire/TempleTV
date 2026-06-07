import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, schema } from "../../infrastructure/db.js";
import { cache } from "../../infrastructure/cache.js";
import { isUndefinedColumnError } from "../../infrastructure/db-schema-guard.js";

/**
 * Public video catalogue surface.
 *
 * Serves TV, mobile, and public-facing surfaces. Supports full server-side
 * search, category filter, sort, and page-based pagination so clients
 * never need to download the entire 2,000+ video catalog to do a search.
 *
 * Caching strategy
 * ────────────────
 * Two layers protect the DB:
 *
 *   1. Server-side cache (Redis or in-process LRU)
 *      Only unfiltered (no search/category) requests are cached (30 s TTL).
 *      A generation counter is bumped on every admin write so cached pages
 *      are immediately stale — no need to enumerate all possible cache keys.
 *      Filtered/searched responses skip server cache (unique per query).
 *
 *   2. HTTP Cache-Control response header
 *      Unfiltered: `public, s-maxage=30, max-age=30, stale-while-revalidate=60`
 *      Filtered:   `public, s-maxage=10, max-age=10, stale-while-revalidate=30`
 *      ETag support for conditional GETs (304 Not Modified).
 */

const videos = schema.videosTable;

// Explicit column projection — only select the 14 fields that toDto() and
// PublicVideoSchema need. This guards against "column does not exist" 500s on
// production DBs whose schema pre-dates columns like `faststart_applied` or
// `metadata_locked` that were added after the initial deploy.  Drizzle's full
// SELECT * includes every column in the TypeScript schema; any column that
// doesn't exist yet in the DB causes PostgreSQL to abort the query with an
// error → 500.  Using an explicit projection generates a minimal SELECT list
// that never references columns outside this safe set.
const VIDEO_COLS = {
  id:           videos.id,
  youtubeId:    videos.youtubeId,
  title:        videos.title,
  description:  videos.description,
  thumbnailUrl: videos.thumbnailUrl,
  duration:     videos.duration,
  category:     videos.category,
  preacher:     videos.preacher,
  publishedAt:  videos.publishedAt,
  importedAt:   videos.importedAt,
  viewCount:    videos.viewCount,
  videoSource:  videos.videoSource,
  localVideoUrl: videos.localVideoUrl,
  hlsMasterUrl: videos.hlsMasterUrl,
  youtubeLiveStatus: sql<string | null>`CASE WHEN ${videos.youtubeLiveStatus} IN ('live','rebroadcast') THEN ${videos.youtubeLiveStatus} ELSE NULL END`,
} as const;

// Safe fallback projection used when `youtube_live_status` column is absent on the
// production DB (pre-migration). Identical to VIDEO_COLS except `youtubeLiveStatus`
// is stubbed as SQL NULL so PostgreSQL never sees the column name in the query.
// Pattern mirrors SAFE_VIDEO_COLS in db-schema-guard.ts — once the migration runs,
// the primary VIDEO_COLS path is always used and this projection is never reached.
const SAFE_CATALOG_COLS = {
  id:           videos.id,
  youtubeId:    videos.youtubeId,
  title:        videos.title,
  description:  videos.description,
  thumbnailUrl: videos.thumbnailUrl,
  duration:     videos.duration,
  category:     videos.category,
  preacher:     videos.preacher,
  publishedAt:  videos.publishedAt,
  importedAt:   videos.importedAt,
  viewCount:    videos.viewCount,
  videoSource:  videos.videoSource,
  localVideoUrl: videos.localVideoUrl,
  hlsMasterUrl: videos.hlsMasterUrl,
  youtubeLiveStatus: sql<string | null>`NULL`,
} as const;

const PublicVideoSchema = z.object({
  id: z.string(),
  youtubeId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  thumbnailUrl: z.string(),
  duration: z.string(),
  category: z.string(),
  preacher: z.string(),
  publishedAt: z.string().nullable(),
  importedAt: z.string(),
  viewCount: z.number().int(),
  videoSource: z.string(),
  localVideoUrl: z.string().nullable(),
  hlsMasterUrl: z.string().nullable(),
  youtubeLiveStatus: z.enum(["live", "rebroadcast"]).nullable(),
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(50),
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "oldest", "published", "views", "title"]).default("newest"),
  // Source filter (library is always YouTube-only; this param is kept for
  // backward compatibility but "local" will always yield zero results since
  // locally-uploaded files are reserved for the 24/7 broadcast feed).
  source: z.enum(["youtube", "local"]).optional(),
});

const ListResponseSchema = z.object({
  videos: z.array(PublicVideoSchema),
  total: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

type CatalogResponse = z.infer<typeof ListResponseSchema>;

// Cached ETag stored alongside the payload so we never recompute SHA-1 on hits.
interface CachedCatalogEntry {
  payload: CatalogResponse;
  etag: string;
}

// ── Cache generation counter ──────────────────────────────────────────────────
// Bumped on every admin video write. All old cache keys (which embed the
// previous generation number) become stale and expire naturally after their
// TTL. This gives O(1) cache invalidation without enumerating all key combos.
let catalogGeneration = 0;

function catalogCacheKey(params: {
  sort: string;
  page: number;
  limit: number;
}): string {
  return `videos:catalog2:g${catalogGeneration}:${params.sort}:${params.page}:${params.limit}`;
}

/**
 * Exported so admin video mutation routes can proactively evict the
 * catalogue cache after any write. Bumps the generation counter so all
 * cached pages become stale on the next request without explicit key deletion.
 */
export async function invalidateVideosCatalogCache(): Promise<void> {
  // Save the old generation before incrementing so the proactive delete
  // targets an existing key (old gen), not the brand-new empty one (new gen).
  const oldGen = catalogGeneration;
  catalogGeneration++;
  // Proactively evict the most-hit cache variant from the previous generation.
  // New requests compute keys using the incremented generation and always miss,
  // so correctness is guaranteed even if this del fails.
  // NOTE: key prefix must be "catalog2" to match catalogCacheKey() output.
  const c = cache();
  await c.del(`videos:catalog2:g${oldGen}:newest:1:50`).catch(() => {});
}

type VideoDtoRow = Pick<typeof videos.$inferSelect,
  "id" | "youtubeId" | "title" | "description" | "thumbnailUrl" | "duration" |
  "category" | "preacher" | "publishedAt" | "importedAt" | "viewCount" |
  "videoSource" | "localVideoUrl" | "hlsMasterUrl"
> & { youtubeLiveStatus?: string | null };

function toDto(v: VideoDtoRow) {
  const liveStatus = v.youtubeLiveStatus === "live" || v.youtubeLiveStatus === "rebroadcast"
    ? v.youtubeLiveStatus as "live" | "rebroadcast"
    : null;
  return {
    id: v.id,
    youtubeId: v.youtubeId,
    title: v.title,
    description: v.description ?? "",
    thumbnailUrl: v.thumbnailUrl ?? "",
    duration: v.duration ?? "",
    category: v.category ?? "",
    preacher: v.preacher ?? "",
    publishedAt: v.publishedAt,
    importedAt: v.importedAt.toISOString(),
    viewCount: v.viewCount,
    videoSource: v.videoSource,
    localVideoUrl: v.localVideoUrl,
    hlsMasterUrl: v.hlsMasterUrl,
    youtubeLiveStatus: liveStatus,
  };
}

// Safe cast for the text `published_at` column.  Production has rows whose
// value is an empty string or otherwise malformed (the column predates strict
// validation), and a raw `::timestamptz` cast throws — which 500s the entire
// list endpoint.  NULLIF strips empty strings; the regex guard treats anything
// that doesn't start with 4 digits as NULL so the cast only ever sees ISO-ish
// timestamps.  Result: bad rows sort as NULL rather than aborting the query.
const SAFE_PUB_AT = sql`CASE WHEN ${videos.publishedAt} ~ '^[0-9]{4}' THEN NULLIF(${videos.publishedAt}, '')::timestamptz ELSE NULL END`;

function buildOrderBy(sort: string) {
  // For "newest" / "oldest" prefer the video's own publish date (YouTube date) so
  // that the library order matches the channel chronologically.  Local uploads
  // that have no publishedAt fall back to importedAt so they still sort sensibly.
  switch (sort) {
    case "oldest":
      return sql`COALESCE(${SAFE_PUB_AT}, ${videos.importedAt}) ASC`;
    case "published":
      return sql`${SAFE_PUB_AT} DESC NULLS LAST`;
    case "views":
      return desc(videos.viewCount);
    case "title":
      return asc(videos.title);
    default: // "newest"
      return sql`COALESCE(${SAFE_PUB_AT}, ${videos.importedAt}) DESC`;
  }
}

function buildWhere(
  search: string | undefined,
  category: string | undefined,
  source: "youtube" | "local" | undefined,
): SQL | undefined {
  // Policy: the public Library is YouTube-only.
  // Locally-uploaded videos are reserved for the 24/7 broadcast feed and
  // must never surface in the public catalogue. This clause is unconditional
  // so it cannot be bypassed via the `source` query param.
  //
  // CRITICAL: we MUST use the SAFE_PUB_AT CASE helper instead of a direct
  // `::timestamptz` cast here. PostgreSQL's planner does not reliably
  // short-circuit operands of an OR clause — it may evaluate the cast on
  // rows whose `published_at` is empty/malformed even when an earlier
  // `IS NULL` / regex guard would have eliminated them. The cast then
  // throws "invalid input syntax for type timestamp with time zone" and
  // the entire `/api/videos` endpoint returns 500. The same pattern is
  // already used in `buildOrderBy` for the same reason — `buildWhere`
  // had been missing it (prod May 2026 outage).
  const clauses: SQL[] = [
    // Only YouTube content in the public Library.
    sql`${videos.videoSource} = 'youtube'`,
    // Exclude stale YouTube content older than 2 years (keeps the library fresh).
    // Rows whose published_at is NULL are kept as a safety net.
    sql`(${SAFE_PUB_AT} IS NULL OR ${SAFE_PUB_AT} >= NOW() - INTERVAL '2 years')`,
    // Exclude items explicitly marked broadcast-only by an admin.
    // COALESCE guards prod DBs whose schema may pre-date this column.
    sql`COALESCE(${videos.broadcastOnly}, false) = false`,
  ];

  if (search?.trim()) {
    // Full-text search via PostgreSQL GIN tsvector index.
    // plainto_tsquery converts the raw input into a phrase query (AND of terms)
    // without requiring the caller to use tsquery syntax. Falls back gracefully
    // to an empty result (vs. a 500) when the query is only stop-words.
    clauses.push(
      sql`to_tsvector('english', coalesce(${videos.title},'') || ' ' || coalesce(${videos.preacher},'') || ' ' || coalesce(${videos.description},'')) @@ plainto_tsquery('english', ${search.trim()})`,
    );
  }

  if (category?.trim()) {
    const catLower = category.trim().toLowerCase();
    // "teaching" and "sermon" are synonyms in this system:
    // detectCategory() defaults to "sermon" for uncategorised videos, but the
    // mobile/TV clients call the same bucket "Teachings" and send "teaching" as
    // the filter slug.  Matching both means the 2,000+ auto-classified videos
    // actually appear when a viewer taps the "Teachings" filter.
    //
    // The remaining synonyms handle plural/singular forms sent by the client
    // (e.g. "prayers" from the mobile filter pill) vs. the singular slugs
    // stored by detectCategory() in the DB ("prayer", "crusade", etc.).
    if (catLower === "live_service" || catLower === "live-service" || catLower === "live service") {
      clauses.push(sql`lower(${videos.category}) IN ('live_service', 'live-service', 'live service')`);
    } else if (catLower === "teaching" || catLower === "sermon") {
      clauses.push(sql`lower(${videos.category}) IN ('teaching', 'sermon')`);
    } else if (catLower === "prayer" || catLower === "prayers") {
      clauses.push(sql`lower(${videos.category}) IN ('prayer', 'prayers')`);
    } else if (catLower === "crusade" || catLower === "crusades") {
      clauses.push(sql`lower(${videos.category}) IN ('crusade', 'crusades')`);
    } else if (catLower === "conference" || catLower === "conferences") {
      clauses.push(sql`lower(${videos.category}) IN ('conference', 'conferences')`);
    } else if (catLower === "testimony" || catLower === "testimonies") {
      clauses.push(sql`lower(${videos.category}) IN ('testimony', 'testimonies')`);
    } else {
      clauses.push(sql`lower(${videos.category}) = lower(${category.trim()})`);
    }
  }

  if (source) {
    clauses.push(sql`${videos.videoSource} = ${source}`);
  }

  return clauses.length > 0 ? and(...clauses) : undefined;
}

export async function videosRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /videos — paginated catalogue with search / filter / sort ──────────
  r.get(
    "/",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["videos"],
        summary: "Public video catalogue with server-side search, filter, sort and pagination",
        querystring: ListQuerySchema,
        response: { 200: ListResponseSchema, 304: z.void() },
      },
    },
    async (req, reply) => {
      const { limit, page, search, category, sort, source } = req.query;
      const isFiltered = !!(search?.trim() || category?.trim() || source);
      const offset = (page - 1) * limit;
      const where = buildWhere(search, category, source);
      const orderBy = buildOrderBy(sort);

      // ── Server-side cache (unfiltered requests only) ──────────────────────
      if (!isFiltered) {
        const cacheKey = catalogCacheKey({ sort, page, limit });
        // Store payload + etag together so cache hits cost zero SHA-1 work.
        const cached = await cache().get<CachedCatalogEntry>(cacheKey).catch(() => null);
        if (cached?.payload && cached?.etag) {
          if (req.headers["if-none-match"] === cached.etag) {
            return reply.status(304).send();
          }
          return reply
            .header("Cache-Control", "public, s-maxage=30, max-age=30, stale-while-revalidate=60")
            .header("ETag", cached.etag)
            .header("X-Cache", "HIT")
            .send(cached.payload);
        }
      }

      // ── DB query ──────────────────────────────────────────────────────────
      // Primary path uses VIDEO_COLS (includes youtubeLiveStatus CASE expression).
      // Falls back to SAFE_CATALOG_COLS (stubs youtubeLiveStatus as NULL) on 42703
      // so production DBs that haven't yet run the youtube_live_status migration
      // continue to serve the catalog rather than returning 500.
      type CatalogRows = Array<{ [K in keyof typeof VIDEO_COLS]: unknown }>;
      let totalRow: Array<{ c: unknown }>;
      let rows: CatalogRows;
      try {
        [totalRow, rows] = await Promise.all([
          db.select({ c: count() }).from(videos).where(where),
          db
            .select(VIDEO_COLS)
            .from(videos)
            .where(where)
            .orderBy(orderBy)
            .limit(limit)
            .offset(offset),
        ]) as [typeof totalRow, CatalogRows];
      } catch (err) {
        if (!isUndefinedColumnError(err)) throw err;
        [totalRow, rows] = await Promise.all([
          db.select({ c: count() }).from(videos).where(where),
          db
            .select(SAFE_CATALOG_COLS)
            .from(videos)
            .where(where)
            .orderBy(orderBy)
            .limit(limit)
            .offset(offset),
        ]) as [typeof totalRow, CatalogRows];
      }

      const total = Number(totalRow[0]?.c ?? 0);
      const totalPages = Math.max(1, Math.ceil(total / limit));

      const result: CatalogResponse = {
        videos: rows.map(v => toDto(v as unknown as VideoDtoRow)),
        total,
        totalPages,
        page,
        limit,
      };

      // ETag fingerprint — hash a compact, deterministic projection of the
      // response rather than the full JSON payload. With limit up to 2,000
      // items, JSON.stringify on the full result (descriptions, thumbnail URLs,
      // etc.) was blocking the event loop for hundreds of ms per cache miss
      // and spiking RSS. The fingerprint changes whenever rows, order, count,
      // or pagination changes — sufficient for HTTP cache correctness. (P0 fix)
      const fingerprint = `${total}|${page}|${limit}|${rows.length}|${rows
        .map((r) => `${r.id}:${r.importedAt instanceof Date ? r.importedAt.getTime() : r.importedAt}`)
        .join(",")}`;
      const etag = `"${createHash("sha1").update(fingerprint).digest("hex").slice(0, 16)}"`;

      // Cache unfiltered responses (payload + pre-computed etag).
      if (!isFiltered) {
        const cacheKey = catalogCacheKey({ sort, page, limit });
        const entry: CachedCatalogEntry = { payload: result, etag };
        cache().set(cacheKey, entry, 30).catch(() => {});
      }

      if (req.headers["if-none-match"] === etag) {
        return reply.status(304).send();
      }

      const cacheControl = isFiltered
        ? "public, s-maxage=10, max-age=10, stale-while-revalidate=30"
        : "public, s-maxage=30, max-age=30, stale-while-revalidate=60";

      return reply
        .header("Cache-Control", cacheControl)
        .header("ETag", etag)
        .header("X-Cache", "MISS")
        .send(result);
    },
  );

  // ── GET /videos/featured — top videos by view count ───────────────────────
  // Returns a curated list of the most-viewed videos. The `/featured` segment
  // must be registered BEFORE `/:id` so the router matches it as a literal path
  // rather than treating "featured" as a video ID.
  r.get(
    "/featured",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["videos"],
        summary: "Featured videos — top 12 by view count",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(12),
        }),
        response: { 200: z.object({ videos: z.array(PublicVideoSchema) }) },
      },
    },
    async (req, reply) => {
      const { limit } = req.query;
      let rows: Array<{ [K in keyof typeof VIDEO_COLS]: unknown }>;
      try {
        rows = await db
          .select(VIDEO_COLS)
          .from(videos)
          .orderBy(desc(videos.viewCount))
          .limit(limit) as typeof rows;
      } catch (err) {
        if (!isUndefinedColumnError(err)) throw err;
        rows = await db
          .select(SAFE_CATALOG_COLS)
          .from(videos)
          .orderBy(desc(videos.viewCount))
          .limit(limit) as typeof rows;
      }
      return reply
        .header("Cache-Control", "public, s-maxage=60, max-age=60, stale-while-revalidate=120")
        .send({ videos: rows.map(v => toDto(v as unknown as VideoDtoRow)) });
    },
  );

  // ── GET /videos/:id — single video lookup ─────────────────────────────────
  r.get(
    "/:id",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["videos"],
        summary: "Get a single video by ID",
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: PublicVideoSchema,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      let row: ({ [K in keyof typeof VIDEO_COLS]: unknown }) | undefined;
      try {
        const [r] = await db
          .select(VIDEO_COLS)
          .from(videos)
          .where(eq(videos.id, req.params.id))
          .limit(1);
        row = r as typeof row;
      } catch (err) {
        if (!isUndefinedColumnError(err)) throw err;
        const [r] = await db
          .select(SAFE_CATALOG_COLS)
          .from(videos)
          .where(eq(videos.id, req.params.id))
          .limit(1);
        row = r as typeof row;
      }
      if (!row) {
        reply.status(404);
        return { error: "Video not found" };
      }
      return toDto(row as Parameters<typeof toDto>[0]);
    },
  );

  // ── POST /videos/:id/view — increment view count ──────────────────────────
  r.post(
    "/:id/view",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["videos"],
        summary: "Increment view count for a video",
        params: z.object({ id: z.string().min(1) }),
        response: {
          202: z.object({ ok: z.literal(true) }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const result = await db
        .update(videos)
        .set({ viewCount: sql`${videos.viewCount} + 1` })
        .where(eq(videos.id, req.params.id))
        .returning({ id: videos.id });
      if (result.length === 0) {
        reply.status(404);
        return { error: "Video not found" };
      }
      reply.code(202);
      return { ok: true as const };
    },
  );
}
