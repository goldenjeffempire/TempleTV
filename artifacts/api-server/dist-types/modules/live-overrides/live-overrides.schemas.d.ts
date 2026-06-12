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
    id: string;
    title: string;
    endsAt: string | null;
    startedAt: string;
    hlsStreamUrl: string | null;
    youtubeVideoId: string | null;
    isActive: boolean;
    createdAt: string;
    rtmpIngestKey: string | null;
    streamNotes: string | null;
    scheduledFor: string | null;
    autoStarted: boolean;
}, {
    id: string;
    title: string;
    endsAt: string | null;
    startedAt: string;
    hlsStreamUrl: string | null;
    youtubeVideoId: string | null;
    isActive: boolean;
    createdAt: string;
    rtmpIngestKey: string | null;
    streamNotes: string | null;
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
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        isActive: boolean;
        createdAt: string;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
    }, {
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        isActive: boolean;
        createdAt: string;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
    }>>;
}, "strip", z.ZodTypeAny, {
    isLive: boolean;
    active: {
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        isActive: boolean;
        createdAt: string;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
    } | null;
}, {
    isLive: boolean;
    active: {
        id: string;
        title: string;
        endsAt: string | null;
        startedAt: string;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        isActive: boolean;
        createdAt: string;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
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
    endsAt?: string | null | undefined;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}, {
    title: string;
    endsAt?: string | null | undefined;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}>, {
    title: string;
    endsAt?: string | null | undefined;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}, {
    title: string;
    endsAt?: string | null | undefined;
    hlsStreamUrl?: string | null | undefined;
    rtmpIngestKey?: string | null | undefined;
    streamNotes?: string | null | undefined;
    scheduledFor?: string | null | undefined;
    youtubeUrl?: string | null | undefined;
}>;
