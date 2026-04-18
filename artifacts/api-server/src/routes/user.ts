import { Router } from "express";
import { randomUUID } from "crypto";
import { db, userFavoritesTable, userWatchHistoryTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { z } from "zod";

const router = Router();

const FavoriteBody = z.object({
  videoId: z.string().min(1),
  videoTitle: z.string().min(1),
  videoThumbnail: z.string().default(""),
  videoCategory: z.string().default(""),
});

const HistoryBody = z.object({
  videoId: z.string().min(1),
  videoTitle: z.string().min(1),
  videoThumbnail: z.string().default(""),
  videoCategory: z.string().default(""),
  progressSecs: z.number().int().min(0).default(0),
});

router.get("/user/favorites", requireAuth, async (req, res) => {
  const favorites = await db
    .select()
    .from(userFavoritesTable)
    .where(eq(userFavoritesTable.userId, req.user!.id))
    .orderBy(desc(userFavoritesTable.createdAt));
  res.json({ favorites });
});

router.post("/user/favorites", requireAuth, async (req, res) => {
  const parsed = FavoriteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const existing = await db
    .select({ id: userFavoritesTable.id })
    .from(userFavoritesTable)
    .where(
      and(
        eq(userFavoritesTable.userId, req.user!.id),
        eq(userFavoritesTable.videoId, parsed.data.videoId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    res.json({ success: true, alreadyExists: true });
    return;
  }

  await db.insert(userFavoritesTable).values({
    id: randomUUID(),
    userId: req.user!.id,
    ...parsed.data,
  });

  res.status(201).json({ success: true });
});

router.delete("/user/favorites/:videoId", requireAuth, async (req, res) => {
  const videoId = req.params["videoId"] as string;
  await db
    .delete(userFavoritesTable)
    .where(
      and(
        eq(userFavoritesTable.userId, req.user!.id),
        eq(userFavoritesTable.videoId, videoId),
      ),
    );
  res.json({ success: true });
});

router.get("/user/history", requireAuth, async (req, res) => {
  const history = await db
    .select()
    .from(userWatchHistoryTable)
    .where(eq(userWatchHistoryTable.userId, req.user!.id))
    .orderBy(desc(userWatchHistoryTable.watchedAt))
    .limit(100);
  res.json({ history });
});

router.post("/user/history", requireAuth, async (req, res) => {
  const parsed = HistoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const existing = await db
    .select({ id: userWatchHistoryTable.id })
    .from(userWatchHistoryTable)
    .where(
      and(
        eq(userWatchHistoryTable.userId, req.user!.id),
        eq(userWatchHistoryTable.videoId, parsed.data.videoId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(userWatchHistoryTable)
      .set({
        watchedAt: new Date(),
        progressSecs: parsed.data.progressSecs,
        videoTitle: parsed.data.videoTitle,
        videoThumbnail: parsed.data.videoThumbnail,
        videoCategory: parsed.data.videoCategory,
      })
      .where(eq(userWatchHistoryTable.id, existing[0].id));
  } else {
    await db.insert(userWatchHistoryTable).values({
      id: randomUUID(),
      userId: req.user!.id,
      ...parsed.data,
    });
  }

  res.json({ success: true });
});

router.delete("/user/history", requireAuth, async (req, res) => {
  await db
    .delete(userWatchHistoryTable)
    .where(eq(userWatchHistoryTable.userId, req.user!.id));
  res.json({ success: true });
});

export default router;
