import { and, desc, eq, ilike, ne, sql, count } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { NotFoundError } from "../../shared/errors.js";
import { isUndefinedColumnError, SAFE_VIDEO_COLS } from "../../infrastructure/db-schema-guard.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import type { z } from "zod";
import type {
  CreateMediaBodySchema,
  ListMediaQuerySchema,
  SignedUploadBodySchema,
  UpdateMediaBodySchema,
} from "./media.schemas.js";

const videos = schema.videosTable;

function toDto(row: typeof videos.$inferSelect) {
  return {
    id: row.id,
    youtubeId: row.youtubeId,
    title: row.title,
    // DB columns are nullable; the schema declares z.string() so we coerce
    // null → "" to prevent Zod from rejecting the serialized response (500).
    description: row.description ?? "",
    thumbnailUrl: row.thumbnailUrl ?? "",
    duration: row.duration ?? "",
    category: row.category ?? "",
    preacher: row.preacher ?? "",
    publishedAt: row.publishedAt,
    importedAt: row.importedAt.toISOString(),
    viewCount: row.viewCount,
    featured: row.featured,
    videoSource: row.videoSource,
    localVideoUrl: row.localVideoUrl,
    hlsMasterUrl: row.hlsMasterUrl,
  };
}

export const mediaService = {
  async list(query: z.infer<typeof ListMediaQuerySchema>) {
    const conditions: ReturnType<typeof eq>[] = [
      // Library is YouTube-only. Local uploads are for broadcast only.
      ne(videos.videoSource, "local") as ReturnType<typeof eq>,
    ];
    if (query.category) conditions.push(eq(videos.category, query.category));
    if (query.featured !== undefined) conditions.push(eq(videos.featured, query.featured));
    if (query.search) conditions.push(ilike(videos.title, `%${query.search}%`) as ReturnType<typeof eq>);
    const where = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(videos)
        .where(where)
        .orderBy(desc(videos.importedAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ c: count() }).from(videos).where(where),
    ]);

    return {
      items: rows.map(toDto),
      total: Number(totalRows[0]?.c ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  },

  async getById(id: string) {
    const rows = await db
      .select()
      .from(videos)
      .where(eq(videos.id, id))
      .limit(1)
      .catch(async (err: unknown) => {
        if (!isUndefinedColumnError(err)) throw err;
        return db
          .select(SAFE_VIDEO_COLS)
          .from(videos)
          .where(eq(videos.id, id))
          .limit(1) as unknown as (typeof videos.$inferSelect)[];
      });
    const row = rows[0];
    if (!row) throw new NotFoundError("Media item not found");
    return toDto(row);
  },

  async create(body: z.infer<typeof CreateMediaBodySchema>) {
    const id = nanoid();
    const inserted = await db
      .insert(videos)
      .values({
        id,
        youtubeId: body.youtubeId,
        title: body.title,
        description: body.description,
        thumbnailUrl: body.thumbnailUrl,
        duration: body.duration,
        category: body.category,
        preacher: body.preacher,
        publishedAt: body.publishedAt ?? null,
        videoSource: body.videoSource,
        localVideoUrl: body.localVideoUrl ?? null,
        featured: body.featured,
      })
      .returning();
    void invalidateVideosCatalogCache();
    return toDto(inserted[0]!);
  },

  async update(id: string, body: z.infer<typeof UpdateMediaBodySchema>) {
    const patch: Partial<typeof videos.$inferInsert> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.thumbnailUrl !== undefined) patch.thumbnailUrl = body.thumbnailUrl;
    if (body.duration !== undefined) patch.duration = body.duration;
    if (body.category !== undefined) patch.category = body.category;
    if (body.preacher !== undefined) patch.preacher = body.preacher;
    if (body.featured !== undefined) patch.featured = body.featured;
    if (body.publishedAt !== undefined) patch.publishedAt = body.publishedAt;
    const updated = await db.update(videos).set(patch).where(eq(videos.id, id)).returning();
    if (updated.length === 0) throw new NotFoundError("Media item not found");
    void invalidateVideosCatalogCache();
    return toDto(updated[0]!);
  },

  async delete(id: string) {
    const deleted = await db.delete(videos).where(eq(videos.id, id)).returning();
    if (deleted.length === 0) throw new NotFoundError("Media item not found");
    void invalidateVideosCatalogCache();
    return { id, deleted: true };
  },

  async incrementViewCount(id: string) {
    await db
      .update(videos)
      .set({ viewCount: sql`${videos.viewCount} + 1` })
      .where(eq(videos.id, id));
  },

  async createSignedUpload(body: z.infer<typeof SignedUploadBodySchema>) {
    const s = storage();
    const key = `uploads/${new Date().toISOString().slice(0, 10)}/${nanoid()}/${body.filename.replace(/[^\w.-]/g, "_")}`;
    const ttl = 900;
    const { url } = await s.signedUploadUrl({ key, contentType: body.contentType, ttlSeconds: ttl });
    return { key, url, expiresIn: ttl };
  },
};
