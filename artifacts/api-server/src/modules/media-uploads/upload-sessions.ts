import { randomUUID } from "node:crypto";

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
  // Set when `s3-multipart-complete` succeeds — used so a retried
  // complete returns the same video row instead of erroring.
  completedVideoId: string | null;
}

class UploadSessionRegistry {
  private sessions = new Map<string, UploadSession>();

  start(args: Omit<UploadSession, "sessionId" | "startedAt" | "completedVideoId">): UploadSession {
    const session: UploadSession = {
      ...args,
      sessionId: randomUUID(),
      startedAt: Date.now(),
      completedVideoId: null,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): UploadSession | undefined {
    return this.sessions.get(sessionId);
  }

  markCompleted(sessionId: string, videoId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.completedVideoId = videoId;
  }

  remove(sessionId: string): UploadSession | undefined {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return s;
  }

  list(): UploadSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}

export const uploadSessions = new UploadSessionRegistry();
