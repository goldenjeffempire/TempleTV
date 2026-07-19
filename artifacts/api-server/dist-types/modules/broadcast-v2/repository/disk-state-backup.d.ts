export interface DiskStateSnapshot {
    channelId: string;
    savedAtMs: number;
    sequence: number;
    mode: string;
    currentItemId: string | null;
    startedAtMs: number | null;
    positionMs: number;
    failoverActive: boolean;
    failoverReason: string | null;
}
/**
 * Persist a state snapshot to disk.  Non-throwing — any I/O error is warned only.
 */
export declare function saveDiskBackup(snap: DiskStateSnapshot): Promise<void>;
/**
 * Load the most recently saved disk snapshot for a channel.
 * Returns null when the file does not exist, is corrupt, or is older than maxAgeMs.
 */
export declare function loadDiskBackup(channelId: string, maxAgeMs?: number): Promise<DiskStateSnapshot | null>;
/**
 * Delete the disk backup for a channel.  Non-throwing.
 * Call when the broadcast finishes cleanly so a stale file cannot cause
 * a wrong restore after a long period of inactivity.
 */
export declare function deleteDiskBackup(channelId: string): Promise<void>;
