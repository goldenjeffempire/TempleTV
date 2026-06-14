import { z } from "zod";

export const BroadcastItemSchema = z.object({
  id: z.string(),
  videoId: z.string().nullable(),
  youtubeId: z.string(),
  title: z.string(),
  thumbnailUrl: z.string(),
  durationSecs: z.number().int().positive(),
  localVideoUrl: z.string().nullable(),
  /**
   * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
   * Present when the video has been transcoded. Players should prefer this over
   * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
   * joining, and proper seeking — all critical for the live broadcast player.
   */
  hlsMasterUrl: z.string().nullable().optional(),
  videoSource: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});

export const BroadcastSnapshotSchema = z.object({
  channelId: z.string(),
  generatedAt: z.string(),
  current: BroadcastItemSchema.nullable(),
  next: BroadcastItemSchema.nullable(),
  upcoming: z.array(BroadcastItemSchema),
  preloadAt: z.string().nullable(),
  failoverHlsUrl: z.string().nullable(),
});

export const AddQueueItemSchema = z
  .object({
    videoId: z.string().min(1).max(128).nullable().optional(),
    youtubeId: z.string().min(1).max(20).nullable().optional(),
    title: z.string().min(1).max(200),
    thumbnailUrl: z.string().max(2048).default(""),
    durationSecs: z.number().int().positive().max(60 * 60 * 12).default(1800),
    localVideoUrl: z.string().max(2048).nullable().optional(),
    /**
     * HLS master playlist URL. Stored on the queue row so the orchestrator's
     * source resolver is self-contained — no managed_videos join required for
     * initial source lookup. Populated immediately when the video already has
     * HLS at enqueue time (e.g. repair-all or library-scan after transcoding);
     * written by transcoder.dispatcher.ts UPDATE when transcoding completes for
     * videos that were enrolled in the queue early as MP4-only.
     */
    hlsMasterUrl: z.string().max(2048).nullable().optional(),
    videoSource: z.enum(["youtube", "local", "hls"]).default("youtube"),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.videoSource === "youtube") {
      // YouTube items must carry a valid 11-character YouTube video ID so
      // the YouTube player surfaces (chat overlay, live ticker, etc.) can
      // use them. The v2 broadcast orchestrator intentionally skips YouTube
      // items — only platform uploads air in the continuous broadcast cycle.
      if (!data.youtubeId || !/^[\w-]{11}$/.test(data.youtubeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["youtubeId"],
          message:
            "YouTube queue items require a valid 11-character YouTube video ID (e.g. dQw4w9WgXcQ)",
        });
      }
    } else {
      // Platform uploads (local / hls) must have at least one of:
      //   localVideoUrl — direct video URL (made absolute at broadcast time)
      //   videoId       — link to a managed_video whose URL is resolved at
      //                   broadcast time from hlsMasterUrl / localVideoUrl
      // Without one of these the orchestrator will always reject the item.
      const hasSource =
        (!!data.localVideoUrl && data.localVideoUrl.trim() !== "") ||
        (!!data.videoId && data.videoId.trim() !== "");
      if (!hasSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["localVideoUrl"],
          message:
            "Platform video queue items (local/hls) require either a localVideoUrl or a linked videoId — item has no playable source",
        });
      }
    }
  });

export const ReorderQueueSchema = z.object({
  // Cap at 1 000 items — well above any realistic queue size — to prevent
  // a client from constructing an array large enough to cause a DB
  // CASE/WHEN clause that exceeds statement-level memory limits.
  itemIds: z.array(z.string().min(1).max(128)).min(1).max(1_000),
});

/**
 * BroadcastCurrentResultSchema — the payload shape mobile clients expect from
 * GET /broadcast/current and the `broadcast-current-updated` SSE event.
 *
 * This is the original "current result" shape that pre-dates the new dual-
 * buffer playback engine. The engine's internal `BroadcastSnapshotDto`
 * differs structurally (`current`/`next` vs `item`/`nextItem`, missing
 * `positionSecs`, etc.). We project the engine snapshot into this shape in
 * the route layer so deployed mobile clients keep working without an app
 * store update.
 */
export const BroadcastCurrentResultSchema = z.object({
  item: BroadcastItemSchema.nullable(),
  nextItem: BroadcastItemSchema.nullable(),
  upcomingItems: z.array(BroadcastItemSchema).optional(),
  index: z.number().int().nonnegative(),
  positionSecs: z.number().nonnegative(),
  totalSecs: z.number().nonnegative(),
  queueLength: z.number().int().nonnegative(),
  progressPercent: z.number().min(0).max(100).optional(),
  syncedAt: z.string().optional(),
  serverTimeMs: z.number().optional(),
  currentItemEndsAtMs: z.number().nullable().optional(),
  itemStartEpochSecs: z.number().nullable().optional(),
  failoverReason: z.string().nullable().optional(),
  failoverHlsUrl: z.string().nullable().optional(),
  activeSchedule: z.null().optional(),
  liveOverride: z
    .object({
      id: z.string(),
      title: z.string(),
      startedAt: z.string(),
      endsAt: z.string().nullable(),
      hlsStreamUrl: z.string().nullable().optional(),
      youtubeVideoId: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  ytLive: z.boolean().optional(),
  ytVideoId: z.string().nullable().optional(),
  ytTitle: z.string().nullable().optional(),
});

export type BroadcastCurrentResultDto = z.infer<typeof BroadcastCurrentResultSchema>;

export type BroadcastItemDto = z.infer<typeof BroadcastItemSchema>;
export type BroadcastSnapshotDto = z.infer<typeof BroadcastSnapshotSchema>;
