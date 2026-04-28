import { and, desc, eq, ilike, sql, count } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { NotFoundError } from "../../shared/errors.js";
import type { z } from "zod";
import type {
  CreateMediaBodySchema,
  ListMediaQuerySchema,
  SignedUploadBodySchema,
} from "./media.schemas.js";

const videos = schema.videosTable;

function toDto(row: typeof videos.$inferSelect) {
  return {
    id: row.id,
    youtubeId: row.youtubeId,
    title: row.title,
    description: row.description,
    thumbnailUrl: row.thumbnailUrl,
    duration: row.duration,
    category: row.category,
    preacher: row.preacher,
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
    const conditions = [];
    if (query.category) conditions.push(eq(videos.category, query.category));
    if (query.featured !== undefined) conditions.push(eq(videos.featured, query.featured));
    if (query.search) conditions.push(ilike(videos.title, `%${query.search}%`));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

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
    const rows = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
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
    return toDto(inserted[0]!);
  },

  async delete(id: string) {
    const deleted = await db.delete(videos).where(eq(videos.id, id)).returning();
    if (deleted.length === 0) throw new NotFoundError("Media item not found");
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
    const key = `uploads/${new Date().toISOString().slice(0, 10)}/${nanoid()}/${body.filename.replace(/[^\w.\-]/g, "_")}`;
    const ttl = 900;
    const { url } = await s.signedUploadUrl({ key, contentType: body.contentType, ttlSeconds: ttl });
    return { key, url, expiresIn: ttl };
  },
};
