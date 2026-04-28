import type { z } from "zod";
import type { StartOverrideBodySchema } from "./live-overrides.schemas.js";
export declare const liveOverridesService: {
    getStatus(): Promise<{
        isLive: boolean;
        active: {
            id: string;
            title: string;
            isActive: boolean;
            hlsStreamUrl: string | null;
            youtubeVideoId: string | null;
            rtmpIngestKey: string | null;
            streamNotes: string | null;
            startedAt: string;
            endsAt: string | null;
            scheduledFor: string | null;
            autoStarted: boolean;
            createdAt: string;
        } | null;
    }>;
    start(body: z.infer<typeof StartOverrideBodySchema>): Promise<{
        id: string;
        title: string;
        isActive: boolean;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        startedAt: string;
        endsAt: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
        createdAt: string;
    }>;
    stop(): Promise<{
        id: string;
        title: string;
        isActive: boolean;
        hlsStreamUrl: string | null;
        youtubeVideoId: string | null;
        rtmpIngestKey: string | null;
        streamNotes: string | null;
        startedAt: string;
        endsAt: string | null;
        scheduledFor: string | null;
        autoStarted: boolean;
        createdAt: string;
    }>;
    listRecent(limit?: number): Promise<{
        items: {
            id: string;
            title: string;
            isActive: boolean;
            hlsStreamUrl: string | null;
            youtubeVideoId: string | null;
            rtmpIngestKey: string | null;
            streamNotes: string | null;
            startedAt: string;
            endsAt: string | null;
            scheduledFor: string | null;
            autoStarted: boolean;
            createdAt: string;
        }[];
        total: number;
    }>;
};
