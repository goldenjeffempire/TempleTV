import type { z } from "zod";
import type { ListNotificationsQuerySchema, SendPushBodySchema } from "./notifications.schemas.js";
export declare const notificationsService: {
    listHistory(query: z.infer<typeof ListNotificationsQuerySchema>): Promise<{
        items: {
            id: string;
            title: string;
            body: string;
            type: string;
            videoId: string | null;
            sentAt: string;
            createdAt: string;
            scheduledAt: string;
            sentCount: number;
            status: string;
            attempts: number;
            errorMessage: string | null;
        }[];
        total: number;
        limit: number;
        offset: number;
    }>;
    /**
     * Queue a push notification for delivery.
     *
     * Dedup contract: if `idempotencyKey` is supplied and a row already
     * exists for it, return that row with `deduplicated: true`. The
     * unique partial index on `idempotency_key` is the source of truth
     * — we use it via INSERT ... ON CONFLICT semantics to make this
     * race-free across replicas.
     *
     * Recipient counting and audit-row insertion are wrapped in a single
     * transaction so a partial failure (e.g. count succeeds, insert
     * fails) doesn't leave orphaned state.
     */
    sendPush(body: z.infer<typeof SendPushBodySchema>): Promise<{
        recipients: number;
        delivered: number;
        deduplicated: boolean;
        id: string;
        title: string;
        body: string;
        type: string;
        videoId: string | null;
        sentAt: string;
        createdAt: string;
        scheduledAt: string;
        sentCount: number;
        status: string;
        attempts: number;
        errorMessage: string | null;
    }>;
};
