import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";

/**
 * Admin video listing.
 *
 * The admin SPA's broadcast page calls `GET /admin/videos?search=&limit=`
 * to populate the "add from library" picker. The public `GET /media`
 * exists but only returns surface fields (no `videoSource`, no upload
 * metadata, no transcoding status), and pages from a different cursor
 * scheme. This admin endpoint exposes the full row + the filters the
 * SPA actually uses (search across title/preacher/youtubeId, source +
 * featured filters, simple page/limit pagination).
 */

const videos = schema.videosTable;

const VideoRowSchema = z.object({
  id: z.string(),
  youtubeId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  thumbnailUrl: z.string(),
  duration: z.string().nullable(),
  category: z.string().nullable(),
  preacher: z.string().nullable(),
  publishedAt: z.string().nullable(),
  importedAt: z.string(),
  viewCount: z.number().int().nonnegative(),
  featured: z.boolean(),
  videoSource: z.string(),
  localVideoUrl: z.string().nullable(),
  hlsMasterUrl: z.string().nullable(),
  transcodingStatus: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  mimeType: z.string().nullable(),
  originalFilename: z.string().nullable(),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(30),
  search: z.string().trim().max(200).optional(),
  source: z.enum(["youtube", "local", "hls"]).optional(),
  featured: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
});

const ListResponseSchema = z.object({
  videos: z.array(VideoRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
});

function toDto(row: typeof videos.$inferSelect): z.infer<typeof VideoRowSchema> {
  // The admin SPA's `LibraryVideo` type allows `youtubeId: string | null`
  // because synthetic local ids (`local-<uuid>`) aren't real YouTube ids.
  // Strip them here so the picker doesn't try to embed an iframe pointed
  // at a nonexistent video.
  const yt = row.youtubeId?.startsWith("local-") ? null : row.youtubeId;
  return {
    id: row.id,
    youtubeId: yt,
    title: row.title,
    description: row.description,
    thumbnailUrl: row.thumbnailUrl,
    duration: row.duration || null,
    category: row.category || null,
    preacher: row.preacher || null,
    publishedAt: row.publishedAt,
    importedAt: row.importedAt.toISOString(),
    viewCount: row.viewCount,
    featured: row.featured,
    videoSource: row.videoSource,
    localVideoUrl: row.localVideoUrl,
    hlsMasterUrl: row.hlsMasterUrl,
    transcodingStatus: row.transcodingStatus,
    sizeBytes: row.sizeBytes ?? null,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
  };
}

export async function adminVideosRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/videos",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Paginated, searchable video library for the admin picker",
        querystring: ListQuerySchema,
        response: { 200: ListResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const q = req.query as z.infer<typeof ListQuerySchema>;
      const offset = (q.page - 1) * q.limit;

      const filters: SQL[] = [];
      if (q.search) {
        const needle = `%${q.search.replace(/[%_]/g, "\\$&")}%`;
        const matchOr = or(
          ilike(videos.title, needle),
          ilike(videos.preacher, needle),
          ilike(videos.youtubeId, needle),
        );
        if (matchOr) filters.push(matchOr);
      }
      if (q.source) filters.push(eq(videos.videoSource, q.source));
      if (q.featured !== undefined) filters.push(eq(videos.featured, q.featured));

      const where = filters.length > 0 ? and(...filters) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(videos)
          .where(where as SQL | undefined)
          .orderBy(desc(videos.importedAt))
          .limit(q.limit)
          .offset(offset),
        db
          .select({ c: count() })
          .from(videos)
          .where(where as SQL | undefined),
      ]);

      return {
        videos: rows.map(toDto),
        total: Number(totalRows[0]?.c ?? 0),
        page: q.page,
        limit: q.limit,
      };
    },
  );
}
