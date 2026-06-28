import { logger } from "../../../infrastructure/logger.js";

export type RecoveryTier = "mp4_redownload" | "reupload_required" | "deactivate";
export interface RecoveryResult { ok: boolean; tier?: RecoveryTier; reason?: string }
export interface RecoveryStats {
  attempted: number;
  recovered: number;
  failed: number;
  itemsChecked: number;
  blobsVerified: number;
  gapsFound: number;
  recoveries: number;
  orphanedBlobCount: number;
  deletedOrphanBlobCount: number;
  consecutiveErrors: number;
  lastRunAt: number | null;
  lastPassElapsedMs: number | null;
}
export interface GapRecord { queueId: string; videoId: string | null; reason: string }
export interface FailureRecord { consecutiveGaps: number; lastGapAtMs: number | null; reason: string | null }

const EMPTY_STATS: RecoveryStats = {
  attempted: 0,
  recovered: 0,
  failed: 0,
  itemsChecked: 0,
  blobsVerified: 0,
  gapsFound: 0,
  recoveries: 0,
  orphanedBlobCount: 0,
  deletedOrphanBlobCount: 0,
  consecutiveErrors: 0,
  lastRunAt: null,
  lastPassElapsedMs: null,
};

class StorageBlobRecoveryServiceImpl {
  async runWaterfall(_queueId: string): Promise<RecoveryResult> {
    logger.debug("[storage-blob-recovery] disabled — MP4-only pipeline active");
    return { ok: false, reason: "recovery service disabled" };
  }
  async runBulkWaterfall(_queueIds: string[]): Promise<RecoveryStats> {
    return { ...EMPTY_STATS };
  }
  async scanOrphanedBlobs(): Promise<void> {}
  getStats(): RecoveryStats { return { ...EMPTY_STATS }; }
  getFailureRegistry(): Map<string, FailureRecord> { return new Map(); }
}

export const storageBlobRecoveryService = new StorageBlobRecoveryServiceImpl();
