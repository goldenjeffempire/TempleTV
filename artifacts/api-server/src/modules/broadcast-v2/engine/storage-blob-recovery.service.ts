import { logger } from "../../../infrastructure/logger.js";

export type RecoveryTier = "mp4_redownload" | "reupload_required" | "deactivate";
export interface RecoveryResult { ok: boolean; tier?: RecoveryTier; reason?: string }
export interface RecoveryStats { attempted: number; recovered: number; failed: number }
export interface GapRecord { queueId: string; videoId: string | null; reason: string }

class StorageBlobRecoveryServiceImpl {
  async runWaterfall(_queueId: string): Promise<RecoveryResult> {
    logger.debug("[storage-blob-recovery] disabled — MP4-only pipeline active");
    return { ok: false, reason: "recovery service disabled" };
  }
  async runBulkWaterfall(_queueIds: string[]): Promise<RecoveryStats> {
    return { attempted: 0, recovered: 0, failed: 0 };
  }
  async scanOrphanedBlobs(): Promise<void> {}
  getStats(): RecoveryStats { return { attempted: 0, recovered: 0, failed: 0 }; }
}

export const storageBlobRecoveryService = new StorageBlobRecoveryServiceImpl();
