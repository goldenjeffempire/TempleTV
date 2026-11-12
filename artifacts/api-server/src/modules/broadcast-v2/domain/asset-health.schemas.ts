import { z } from "zod/v4";
import { REPAIR_LOG_OUTCOMES } from "@workspace/db";

/** Shared response contract, including historical terminal repair outcomes. */
export const assetHealthRowSchema = z.object({
  id: z.string(),
  queueItemId: z.string(),
  videoId: z.string().nullable(),
  state: z.enum(["healthy", "quarantined", "repairing", "approved", "blocked"]),
  repairAttempts: z.number(),
  lastRepairAt: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  lastError: z.string().nullable(),
  suggestedFix: z.string().nullable(),
  sourceHash: z.string().nullable(),
  autoRepairPaused: z.boolean(),
  repairLog: z.array(z.object({
    ts: z.string(),
    actor: z.enum(["system", "operator"]),
    action: z.string(),
    detail: z.string(),
    outcome: z.enum(REPAIR_LOG_OUTCOMES),
  })),
  createdAt: z.string(),
  updatedAt: z.string(),
});
