import { z } from "zod";
export declare const BroadcastItemSchema: z.ZodObject<{
    id: z.ZodString;
    videoId: z.ZodNullable<z.ZodString>;
    youtubeId: z.ZodString;
    title: z.ZodString;
    thumbnailUrl: z.ZodString;
    durationSecs: z.ZodNumber;
    localVideoUrl: z.ZodNullable<z.ZodString>;
    /**
     * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
     * Present when the video has been transcoded. Players should prefer this over
     * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
     * joining, and proper seeking — all critical for the live broadcast player.
     */
    hlsMasterUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    videoSource: z.ZodString;
    startsAt: z.ZodString;
    endsAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    videoId: string | null;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    localVideoUrl: string | null;
    videoSource: string;
    startsAt: string;
    endsAt: string;
    hlsMasterUrl?: string | null | undefined;
}, {
    id: string;
    videoId: string | null;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    localVideoUrl: string | null;
    videoSource: string;
    startsAt: string;
    endsAt: string;
    hlsMasterUrl?: string | null | undefined;
}>;
export declare const BroadcastSnapshotSchema: z.ZodObject<{
    channelId: z.ZodString;
    generatedAt: z.ZodString;
    current: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        /**
         * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
         * Present when the video has been transcoded. Players should prefer this over
         * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
         * joining, and proper seeking — all critical for the live broadcast player.
         */
        hlsMasterUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }>>;
    next: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        /**
         * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
         * Present when the video has been transcoded. Players should prefer this over
         * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
         * joining, and proper seeking — all critical for the live broadcast player.
         */
        hlsMasterUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }>>;
    upcoming: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        /**
         * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
         * Present when the video has been transcoded. Players should prefer this over
         * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
         * joining, and proper seeking — all critical for the live broadcast player.
         */
        hlsMasterUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }>, "many">;
    preloadAt: z.ZodNullable<z.ZodString>;
    failoverHlsUrl: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    failoverHlsUrl: string | null;
    channelId: string;
    current: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    generatedAt: string;
    upcoming: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }[];
    next: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    preloadAt: string | null;
}, {
    failoverHlsUrl: string | null;
    channelId: string;
    current: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    generatedAt: string;
    upcoming: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }[];
    next: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    preloadAt: string | null;
}>;
export declare const AddQueueItemSchema: z.ZodEffects<z.ZodObject<{
    videoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    youtubeId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    title: z.ZodString;
    thumbnailUrl: z.ZodDefault<z.ZodString>;
    durationSecs: z.ZodDefault<z.ZodNumber>;
    localVideoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    videoSource: z.ZodDefault<z.ZodEnum<["youtube", "local", "hls"]>>;
    sortOrder: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    videoSource: "local" | "youtube" | "hls";
    videoId?: string | null | undefined;
    youtubeId?: string | null | undefined;
    localVideoUrl?: string | null | undefined;
    sortOrder?: number | undefined;
}, {
    title: string;
    videoId?: string | null | undefined;
    youtubeId?: string | null | undefined;
    thumbnailUrl?: string | undefined;
    durationSecs?: number | undefined;
    localVideoUrl?: string | null | undefined;
    videoSource?: "local" | "youtube" | "hls" | undefined;
    sortOrder?: number | undefined;
}>, {
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    videoSource: "local" | "youtube" | "hls";
    videoId?: string | null | undefined;
    youtubeId?: string | null | undefined;
    localVideoUrl?: string | null | undefined;
    sortOrder?: number | undefined;
}, {
    title: string;
    videoId?: string | null | undefined;
    youtubeId?: string | null | undefined;
    thumbnailUrl?: string | undefined;
    durationSecs?: number | undefined;
    localVideoUrl?: string | null | undefined;
    videoSource?: "local" | "youtube" | "hls" | undefined;
    sortOrder?: number | undefined;
}>;
export declare const ReorderQueueSchema: z.ZodObject<{
    itemIds: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    itemIds: string[];
}, {
    itemIds: string[];
}>;
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
export declare const BroadcastCurrentResultSchema: z.ZodObject<{
    item: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        /**
         * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
         * Present when the video has been transcoded. Players should prefer this over
         * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
         * joining, and proper seeking — all critical for the live broadcast player.
         */
        hlsMasterUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }>>;
    nextItem: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        /**
         * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
         * Present when the video has been transcoded. Players should prefer this over
         * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
         * joining, and proper seeking — all critical for the live broadcast player.
         */
        hlsMasterUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }>>;
    upcomingItems: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        /**
         * HLS master playlist URL from the transcoder (e.g. `/api/hls/{id}/master.m3u8`).
         * Present when the video has been transcoded. Players should prefer this over
         * `localVideoUrl` (raw MP4) because HLS supports adaptive bitrate, mid-stream
         * joining, and proper seeking — all critical for the live broadcast player.
         */
        hlsMasterUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }, {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }>, "many">>;
    index: z.ZodNumber;
    positionSecs: z.ZodNumber;
    totalSecs: z.ZodNumber;
    queueLength: z.ZodNumber;
    progressPercent: z.ZodOptional<z.ZodNumber>;
    syncedAt: z.ZodOptional<z.ZodString>;
    serverTimeMs: z.ZodOptional<z.ZodNumber>;
    currentItemEndsAtMs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    itemStartEpochSecs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    failoverReason: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    failoverHlsUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    activeSchedule: z.ZodOptional<z.ZodNull>;
    liveOverride: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        startedAt: z.ZodString;
        endsAt: z.ZodNullable<z.ZodString>;
        hlsStreamUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        youtubeVideoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl?: string | null | undefined;
        youtubeVideoId?: string | null | undefined;
    }, {
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl?: string | null | undefined;
        youtubeVideoId?: string | null | undefined;
    }>>>;
    ytLive: z.ZodOptional<z.ZodBoolean>;
    ytVideoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    ytTitle: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    item: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    nextItem: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    index: number;
    positionSecs: number;
    totalSecs: number;
    queueLength: number;
    upcomingItems?: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }[] | undefined;
    progressPercent?: number | undefined;
    syncedAt?: string | undefined;
    serverTimeMs?: number | undefined;
    currentItemEndsAtMs?: number | null | undefined;
    itemStartEpochSecs?: number | null | undefined;
    failoverReason?: string | null | undefined;
    failoverHlsUrl?: string | null | undefined;
    activeSchedule?: null | undefined;
    liveOverride?: {
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl?: string | null | undefined;
        youtubeVideoId?: string | null | undefined;
    } | null | undefined;
    ytLive?: boolean | undefined;
    ytVideoId?: string | null | undefined;
    ytTitle?: string | null | undefined;
}, {
    item: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    nextItem: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    } | null;
    index: number;
    positionSecs: number;
    totalSecs: number;
    queueLength: number;
    upcomingItems?: {
        id: string;
        videoId: string | null;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        durationSecs: number;
        localVideoUrl: string | null;
        videoSource: string;
        startsAt: string;
        endsAt: string;
        hlsMasterUrl?: string | null | undefined;
    }[] | undefined;
    progressPercent?: number | undefined;
    syncedAt?: string | undefined;
    serverTimeMs?: number | undefined;
    currentItemEndsAtMs?: number | null | undefined;
    itemStartEpochSecs?: number | null | undefined;
    failoverReason?: string | null | undefined;
    failoverHlsUrl?: string | null | undefined;
    activeSchedule?: null | undefined;
    liveOverride?: {
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl?: string | null | undefined;
        youtubeVideoId?: string | null | undefined;
    } | null | undefined;
    ytLive?: boolean | undefined;
    ytVideoId?: string | null | undefined;
    ytTitle?: string | null | undefined;
}>;
export type BroadcastCurrentResultDto = z.infer<typeof BroadcastCurrentResultSchema>;
export type BroadcastItemDto = z.infer<typeof BroadcastItemSchema>;
export type BroadcastSnapshotDto = z.infer<typeof BroadcastSnapshotSchema>;
