import type { z } from "zod";
import type { ListNotificationsQuerySchema, SendPushBodySchema } from "./notifications.schemas.js";
/**
 * Startup/periodic recovery for immediate push notifications stuck in "pending"
 * due to a process crash between DB insert and delivery completion.
 *
 * Rows older than 30 minutes with status="pending" are presumed lost and
 * marked "failed" so the history list doesn't show them as in-flight forever.
 */
export declare function recoverStuckPendingNotifications(): Promise<void>;
export declare const notificationsService: {
    getStats(): Promise<{
        expoTokens: number;
        webSubscriptions: number;
        total: number;
    }>;
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
    sendPush(body: z.infer<typeof SendPushBodySchema>, opts?: {
        awaitDelivery?: boolean;
    }): Promise<{
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
