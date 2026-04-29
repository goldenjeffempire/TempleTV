/**
 * In-memory upload session registry.
 *
 * Tracks every active S3 multipart upload the admin SPA has started so we
 * can:
 *   1. Surface them in the admin Operations tab via
 *      `GET /admin/uploads/active`.
 *   2. Cancel an upload (and abort its S3 multipart upload) via
 *      `DELETE /admin/videos/upload/:id`.
 *   3. Detect duplicate `s3-multipart-complete` retries and return the
 *      previously-inserted videos row instead of double-completing the
 *      upload (which S3 would 400 on anyway).
 *
 * Single-process state. When we move to multi-pod we'll back this with
 * Redis (the same mirror layer the broadcast engine will use); for now
 * a Map is fine because the admin upload modal opens one session at a
 * time per tab and the 38-route Fastify server is single-replica in dev.
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
}
declare class UploadSessionRegistry {
    private sessions;
    start(args: Omit<UploadSession, "sessionId" | "startedAt" | "completedVideoId">): UploadSession;
    get(sessionId: string): UploadSession | undefined;
    markCompleted(sessionId: string, videoId: string): void;
    remove(sessionId: string): UploadSession | undefined;
    list(): UploadSession[];
}
export declare const uploadSessions: UploadSessionRegistry;
export {};
