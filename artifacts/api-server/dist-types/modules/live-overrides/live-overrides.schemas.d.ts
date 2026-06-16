import { z } from "zod";
export declare const LiveOverrideSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    isActive: z.ZodBoolean;
    hlsStreamUrl: z.ZodNullable<z.ZodString>;
    youtubeVideoId: z.ZodNullable<z.ZodString>;
    rtmpIngestKey: z.ZodNullable<z.ZodString>;
    streamNotes: z.ZodNullable<z.ZodString>;
    startedAt: z.ZodString;
    endsAt: z.ZodNullable<z.ZodString>;
    scheduledFor: z.ZodNullable<z.ZodString>;
    autoStarted: z.ZodBoolean;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    startedAt: string;
    id: string;
    title: string;
    isActive: boolean;
    createdAt: string;
    hlsStreamUrl: string | null;
    youtubeVideoId: string | null;
    rtmpIngestKey: string | null;
    streamNotes: string | null;
    endsAt: string | null;
    scheduledFor: string | null;
    autoStarted: boolean;
}, {
    startedAt: string;
    id: string;
    title: string;
    isActive: boolean;
    createdAt: string;
    hlsStreamUrl: string | null;
    youtubeVideoId: string | null;
    rtmpIngestKey: string | null;
    streamNotes: string | null;
    endsAt: string | null;
    scheduledFor: string | null;
    autoStarted: boolean;
}>;
export declare const LiveStatusSchema: z.ZodObject<{
    isLive: z.ZodBoolean;
    active: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        isActive: z.ZodBoolean;
        hlsStreamUrl: z.ZodNullable<z.ZodString>;
        youtubeVideoId: z.ZodNullable<z.ZodString>;
        rtmpIngestKey: z.ZodNullable<z.ZodString>;
        streamNotes: z.ZodNullable<z.ZodString>;
        startedAt: z.ZodString;
        endsAt: z.ZodNullable<z.ZodString>;
        scheduledFor: z.ZodNullable<z.ZodString>;
        autoStarted: z.ZodBoolean;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        startedAt: string;
        id: string;
        title: string;
        isActive: boolean;
        createdAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        endsAt: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
    }, {
        startedAt: string;
        id: string;
        title: string;
        isActive: boolean;
        createdAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        endsAt: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
    }>>;
}, "strip", z.ZodTypeAny, {
    isLive: boolean;
    active: {
        startedAt: string;
        id: string;
        title: string;
        isActive: boolean;
        createdAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        endsAt: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
    } | null;
}, {
    isLive: boolean;
    active: {
        startedAt: string;
        id: string;
        title: string;
        isActive: boolean;
        createdAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        endsAt: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
    } | null;
}>;
export declare const StartOverrideBodySchema: z.ZodEffects<z.ZodObject<{
    title: z.ZodString;
    hlsStreamUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    youtubeUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    rtmpIngestKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    streamNotes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    endsAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    scheduledFor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    endsAt?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}, {
    title: string;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    endsAt?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}>, {
    title: string;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    endsAt?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}, {
    title: string;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    endsAt?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}>;
