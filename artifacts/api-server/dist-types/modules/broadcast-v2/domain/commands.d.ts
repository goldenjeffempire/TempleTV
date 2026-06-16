import { z } from "zod/v4";
export declare const EnqueueCommand: z.ZodObject<{
    videoId: z.ZodString;
    position: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        end: "end";
        next: "next";
    }>>>;
    idempotencyKey: z.ZodString;
}, z.core.$strip>;
export declare const ReorderCommand: z.ZodObject<{
    orderedIds: z.ZodArray<z.ZodString>;
    idempotencyKey: z.ZodString;
}, z.core.$strip>;
export declare const SkipCommand: z.ZodObject<{
    itemId: z.ZodOptional<z.ZodString>;
    idempotencyKey: z.ZodString;
}, z.core.$strip>;
export declare const StartOverrideCommand: z.ZodObject<{
    kind: z.ZodEnum<{
        youtube: "youtube";
        hls: "hls";
        rtmp: "rtmp";
    }>;
    url: z.ZodString;
    title: z.ZodString;
    endsAtMs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    resumeQueueOnEnd: z.ZodDefault<z.ZodBoolean>;
    idempotencyKey: z.ZodString;
}, z.core.$strip>;
export declare const StopOverrideCommand: z.ZodObject<{
    idempotencyKey: z.ZodString;
}, z.core.$strip>;
export declare const ForceFailoverCommand: z.ZodObject<{
    reason: z.ZodString;
    idempotencyKey: z.ZodString;
}, z.core.$strip>;
/**
 * Unauthenticated: player signals that the current source failed to load.
 * After STALL_VOTE_THRESHOLD votes for the same active item the orchestrator
 * auto-skips so a broken URL never leaves every viewer on a black screen.
 */
export declare const ReportStallCommand: z.ZodObject<{
    itemId: z.ZodString;
}, z.core.$strip>;
/**
 * Atomic "promote queue item to front AND immediately play it" command.
 * Reorders the queue so `queueItemId` is first, reloads the orchestrator,
 * then skips — all in a single round-trip so there is no race between the
 * reorder and the skip.
 */
export declare const PlayNowCommand: z.ZodObject<{
    queueItemId: z.ZodString;
    idempotencyKey: z.ZodString;
}, z.core.$strip>;
