/**
 * In-memory upload session registry.
 *
 * Tracks every active multipart upload the admin SPA has started so we can:
 *   1. Surface them in the admin Operations tab via
 *      `GET /admin/uploads/active`.
 *   2. Cancel an upload (and abort its multipart session in storage_blobs)
 *      via `DELETE /admin/videos/upload/:id`.
 *   3. Detect duplicate `s3-multipart-complete` retries and return the
 *      previously-inserted videos row instead of double-completing the
 *      upload.
 *
 * All uploads are stored in PostgreSQL via DatabaseObjectStorage.
 * No S3 or external storage provider is involved.
 *
 * Single-process state. When we move to multi-pod we'll back this with
 * Redis (the same mirror layer the broadcast engine will use); for now
 * a Map is fine because the admin upload modal opens one session at a
 * time per tab and the Fastify server is single-replica in dev.
 */
export interface UploadSession {
    sessionId: string;
    uploadId: string;
    objectKey: string;
    title: string;
    contentType: string;
    sizeBytes: number;
    partSize: number;
    totalParts: number;
    startedAt: number;
    completedVideoId: string | null;
    /** Timestamp (ms since epoch) at which markCompleted() was called.
     *  Used to anchor COMPLETED_TTL_MS correctly — startedAt can be hours
     *  before completion, so using it would evict the session on the very
     *  first sweep after a long upload. */
    completedAt: number | null;
}
declare class UploadSessionRegistry {
    private sessions;
    constructor();
    start(args: Omit<UploadSession, "sessionId" | "startedAt" | "completedVideoId" | "completedAt">): UploadSession;
    get(sessionId: string): UploadSession | undefined;
    markCompleted(sessionId: string, videoId: string): void;
    remove(sessionId: string): UploadSession | undefined;
    /**
     * Re-hydrate a session recovered from the DB into the in-memory registry
     * (used after a server restart to restore in-flight sessions). Does not
     * overwrite an existing in-memory session with the same ID.
     * completedAt is not persisted to the DB, so it defaults to null for
     * recovered sessions; the TTL sweep will use startedAt as a fallback,
     * which is acceptable for the rare post-restart idempotency window.
     */
    restore(session: UploadSession): void;
    list(): UploadSession[];
}
export declare const uploadSessions: UploadSessionRegistry;
export {};
