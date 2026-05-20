import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { NotFoundError, BadRequestError } from "../../shared/errors.js";
import { isUndefinedColumnError, SAFE_VIDEO_COLS } from "../../infrastructure/db-schema-guard.js";
import type {
  CreatePlaylistBodySchema,
  UpdatePlaylistBodySchema,
} from "./playlists.schemas.js";

const playlists = schema.playlistsTable;
const playlistVideos = schema.playlistVideosTable;
const videos = schema.videosTable;

function toDto(row: typeof playlists.$inferSelect, videoCount = 0) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    loopMode: row.loopMode,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    videoCount,
  };
}

function toVideoDto(row: typeof playlistVideos.$inferSelect) {
  return {
    id: row.id,
    playlistId: row.playlistId,
    videoId: row.videoId,
    // PlaylistVideoSchema declares youtubeId, thumbnailUrl, duration, and
    // category as z.string() (non-nullable). The DB columns are nullable —
    // coerce null → "" so Zod response validation never throws a 500.
    youtubeId: row.youtubeId ?? "",
    title: row.title,
    thumbnailUrl: row.thumbnailUrl ?? "",
    duration: row.duration ?? "",
    category: row.category ?? "",
    sortOrder: row.sortOrder,
    addedAt: row.addedAt.toISOString(),
  };
}

export const playlistsService = {
  async list() {
    const rows = await db
      .select({
        playlist: playlists,
        videoCount: sql<number>`coalesce(count(${playlistVideos.id})::int, 0)`,
      })
      .from(playlists)
      .leftJoin(playlistVideos, eq(playlistVideos.playlistId, playlists.id))
      .groupBy(playlists.id)
      .orderBy(desc(playlists.createdAt));

    return {
      items: rows.map((r) => toDto(r.playlist, Number(r.videoCount ?? 0))),
      total: rows.length,
    };
  },

  async getById(id: string) {
    const [head] = await db.select().from(playlists).where(eq(playlists.id, id)).limit(1);
    if (!head) throw new NotFoundError("Playlist not found");

    const items = await db
      .select()
      .from(playlistVideos)
      .where(eq(playlistVideos.playlistId, id))
      .orderBy(asc(playlistVideos.sortOrder), asc(playlistVideos.addedAt));

    return { ...toDto(head, items.length), videos: items.map(toVideoDto) };
  },

  async create(body: z.infer<typeof CreatePlaylistBodySchema>) {
    const id = nanoid();
    const [row] = await db
      .insert(playlists)
      .values({
        id,
        name: body.name,
        description: body.description,
        loopMode: body.loopMode,
        isActive: body.isActive,
      })
      .returning();
    return toDto(row!, 0);
  },

  async update(id: string, body: z.infer<typeof UpdatePlaylistBodySchema>) {
    const patch: Partial<typeof playlists.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.loopMode !== undefined) patch.loopMode = body.loopMode;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (Object.keys(patch).length === 0) {
      return this.getById(id).then(({ videos: _, ...rest }) => rest);
    }
    const [row] = await db
      .update(playlists)
      .set(patch)
      .where(eq(playlists.id, id))
      .returning();
    if (!row) throw new NotFoundError("Playlist not found");
    const [{ c }] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(playlistVideos)
      .where(eq(playlistVideos.playlistId, id));
    return toDto(row, Number(c ?? 0));
  },

  async delete(id: string) {
    const deleted = await db.delete(playlists).where(eq(playlists.id, id)).returning();
    if (deleted.length === 0) throw new NotFoundError("Playlist not found");
    return { id, deleted: true };
  },

  async addVideo(playlistId: string, videoId: string) {
    const [video] = await db
      .select()
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1)
      .catch(async (err: unknown) => {
        if (!isUndefinedColumnError(err)) throw err;
        return db
          .select(SAFE_VIDEO_COLS)
          .from(videos)
          .where(eq(videos.id, videoId))
          .limit(1) as unknown as (typeof videos.$inferSelect)[];
      });
    if (!video) throw new NotFoundError("Video not found in catalog");

    const [head] = await db.select().from(playlists).where(eq(playlists.id, playlistId)).limit(1);
    if (!head) throw new NotFoundError("Playlist not found");

    const [{ maxOrder }] = await db
      .select({ maxOrder: sql<number>`coalesce(max(${playlistVideos.sortOrder})::int, 0)` })
      .from(playlistVideos)
      .where(eq(playlistVideos.playlistId, playlistId));

    const id = nanoid();
    const [inserted] = await db
      .insert(playlistVideos)
      .values({
        id,
        playlistId,
        videoId: video.id,
        youtubeId: video.youtubeId ?? "",
        title: video.title,
        // Coerce nullable DB fields — playlist_videos columns are typed the
        // same way as managed_videos (nullable), so inserting null here would
        // violate a NOT NULL DB constraint or produce a Zod 500 on read-back.
        thumbnailUrl: video.thumbnailUrl ?? "",
        duration: video.duration ?? "",
        category: video.category ?? "",
        sortOrder: Number(maxOrder ?? 0) + 1,
      })
      .returning();
    return toVideoDto(inserted!);
  },

  async removeVideo(playlistId: string, playlistVideoId: string) {
    const deleted = await db
      .delete(playlistVideos)
      .where(and(eq(playlistVideos.playlistId, playlistId), eq(playlistVideos.id, playlistVideoId)))
      .returning();
    if (deleted.length === 0) throw new NotFoundError("Playlist entry not found");
    return { id: playlistVideoId, deleted: true };
  },

  async reorder(playlistId: string, videoIds: string[]) {
    if (videoIds.length === 0) throw new BadRequestError("videoIds must be non-empty");
    const existing = await db
      .select({ id: playlistVideos.id })
      .from(playlistVideos)
      .where(
        and(eq(playlistVideos.playlistId, playlistId), inArray(playlistVideos.id, videoIds)),
      );
    if (existing.length !== videoIds.length) {
      throw new BadRequestError("videoIds contains entries not belonging to this playlist");
    }

    await db.transaction(async (tx) => {
      // Single CASE-based bulk update instead of N serial updates.
      // Eliminates the per-row round-trip overhead; PostgreSQL executes
      // this as one UPDATE scan regardless of how many IDs are reordered.
      const caseExpression = sql`CASE ${sql.join(
        videoIds.map((id, i) => sql`WHEN ${playlistVideos.id} = ${id} THEN ${i + 1}`),
        sql` `,
      )} ELSE ${playlistVideos.sortOrder} END`;
      await tx
        .update(playlistVideos)
        .set({ sortOrder: caseExpression as unknown as number })
        .where(
          and(
            eq(playlistVideos.playlistId, playlistId),
            inArray(playlistVideos.id, videoIds),
          ),
        );
    });

    return this.getById(playlistId);
  },
};
