import { z } from "zod";
export declare const BroadcastItemSchema: z.ZodObject<{
    id: z.ZodString;
    videoId: z.ZodNullable<z.ZodString>;
    youtubeId: z.ZodString;
    title: z.ZodString;
    thumbnailUrl: z.ZodString;
    durationSecs: z.ZodNumber;
    localVideoUrl: z.ZodNullable<z.ZodString>;
    videoSource: z.ZodString;
    startsAt: z.ZodString;
    endsAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    videoSource: string;
    localVideoUrl: string | null;
    durationSecs: number;
    videoId: string | null;
    endsAt: string;
    startsAt: string;
}, {
    id: string;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    videoSource: string;
    localVideoUrl: string | null;
    durationSecs: number;
    videoId: string | null;
    endsAt: string;
    startsAt: string;
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
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }>>;
    next: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }>>;
    upcoming: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        durationSecs: z.ZodNumber;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        videoSource: z.ZodString;
        startsAt: z.ZodString;
        endsAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }>, "many">;
    preloadAt: z.ZodNullable<z.ZodString>;
    failoverHlsUrl: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    channelId: string;
    generatedAt: string;
    current: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    } | null;
    next: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    } | null;
    upcoming: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }[];
    preloadAt: string | null;
    failoverHlsUrl: string | null;
}, {
    channelId: string;
    generatedAt: string;
    current: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    } | null;
    next: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    } | null;
    upcoming: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        videoSource: string;
        localVideoUrl: string | null;
        durationSecs: number;
        videoId: string | null;
        endsAt: string;
        startsAt: string;
    }[];
    preloadAt: string | null;
    failoverHlsUrl: string | null;
}>;
export declare const AddQueueItemSchema: z.ZodObject<{
    videoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    youtubeId: z.ZodString;
    title: z.ZodString;
    thumbnailUrl: z.ZodDefault<z.ZodString>;
    durationSecs: z.ZodDefault<z.ZodNumber>;
    localVideoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    videoSource: z.ZodDefault<z.ZodEnum<["youtube", "local", "hls"]>>;
    sortOrder: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    videoSource: "local" | "youtube" | "hls";
    durationSecs: number;
    localVideoUrl?: string | null | undefined;
    videoId?: string | null | undefined;
    sortOrder?: number | undefined;
}, {
    youtubeId: string;
    title: string;
    thumbnailUrl?: string | undefined;
    videoSource?: "local" | "youtube" | "hls" | undefined;
    localVideoUrl?: string | null | undefined;
    durationSecs?: number | undefined;
    videoId?: string | null | undefined;
    sortOrder?: number | undefined;
}>;
export declare const ReorderQueueSchema: z.ZodObject<{
    itemIds: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    itemIds: string[];
}, {
    itemIds: string[];
}>;
export type BroadcastItemDto = z.infer<typeof BroadcastItemSchema>;
export type BroadcastSnapshotDto = z.infer<typeof BroadcastSnapshotSchema>;
