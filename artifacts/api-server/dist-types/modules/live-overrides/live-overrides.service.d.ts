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
    /**
     * Extend the `endsAt` of the currently-active live override by `extraMinutes`.
     * If the override has no `endsAt`, one is set to `now + extraMinutes`.
     */
    extend(extraMinutes: number): Promise<{
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
    /**
     * Create a new *scheduled* live override (isActive=false, scheduledFor set).
     * The auto-activation scheduler fires when `scheduledFor` is reached.
     */
    schedule(body: z.infer<typeof StartOverrideBodySchema>): Promise<{
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
    /**
     * List upcoming scheduled (not yet active) overrides, soonest first.
     */
    listScheduled(): Promise<{
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
    /**
     * Cancel (delete) a scheduled override that has not yet fired.
     * Refuses to delete an active or already-completed override.
     */
    cancelScheduled(id: string): Promise<{
        ok: true;
        id: string;
    }>;
};
