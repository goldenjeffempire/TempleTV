import { z } from "zod/v4";

export const EnqueueCommand = z.object({
  videoId: z.string().min(1),
  position: z.enum(["end", "next"]).optional().default("end"),
  idempotencyKey: z.string().min(1),
});

export const ReorderCommand = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(500),
  idempotencyKey: z.string().min(1),
});

export const SkipCommand = z.object({
  itemId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
});

export const StartOverrideCommand = z.object({
  kind: z.enum(["youtube", "hls", "rtmp"]),
  url: z.string().min(1).max(2048),
  title: z.string().min(1).max(256),
  endsAtMs: z.number().int().positive().nullable().optional(),
  resumeQueueOnEnd: z.boolean().default(true),
  idempotencyKey: z.string().min(1),
});

export const StopOverrideCommand = z.object({
  idempotencyKey: z.string().min(1),
});

export const ForceFailoverCommand = z.object({
  reason: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1),
});

/**
 * Unauthenticated: player signals that the current source failed to load.
 * After STALL_VOTE_THRESHOLD votes for the same active item the orchestrator
 * auto-skips so a broken URL never leaves every viewer on a black screen.
 */
export const ReportStallCommand = z.object({
  itemId: z.string().min(1),
});

/**
 * Atomic "promote queue item to front AND immediately play it" command.
 * Reorders the queue so `queueItemId` is first, reloads the orchestrator,
 * then skips — all in a single round-trip so there is no race between the
 * reorder and the skip.
 */
export const PlayNowCommand = z.object({
  queueItemId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
