import { randomUUID } from "node:crypto";

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
  // Set when `s3-multipart-complete` succeeds — used so a retried
  // complete returns the same video row instead of erroring.
  completedVideoId: string | null;
  /** Timestamp (ms since epoch) at which markCompleted() was called.
   *  Used to anchor COMPLETED_TTL_MS correctly — startedAt can be hours
   *  before completion, so using it would evict the session on the very
   *  first sweep after a long upload. */
  completedAt: number | null;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;       // 24 h — abandoned incomplete uploads
const COMPLETED_TTL_MS = 60 * 60 * 1000;           // 1 h  — completed sessions kept for idempotency

class UploadSessionRegistry {
  private sessions = new Map<string, UploadSession>();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        if (s.completedVideoId !== null) {
          // Anchor to completedAt so COMPLETED_TTL_MS is measured from the
          // time of completion, not session start. Without this, a session
          // that took 23+ hours to upload would be evicted on the very first
          // sweep after completion (now - startedAt > 1h is always true).
          const anchor = s.completedAt ?? s.startedAt;
          if (now - anchor > COMPLETED_TTL_MS) this.sessions.delete(id);
        } else {
          if (now - s.startedAt > SESSION_TTL_MS) this.sessions.delete(id);
        }
      }
    }, 15 * 60 * 1000).unref(); // sweep every 15 min
  }

  start(args: Omit<UploadSession, "sessionId" | "startedAt" | "completedVideoId" | "completedAt">): UploadSession {
    const session: UploadSession = {
      ...args,
      sessionId: randomUUID(),
      startedAt: Date.now(),
      completedVideoId: null,
      completedAt: null,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): UploadSession | undefined {
    return this.sessions.get(sessionId);
  }

  markCompleted(sessionId: string, videoId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.completedVideoId = videoId;
      s.completedAt = Date.now();
    }
  }

  remove(sessionId: string): UploadSession | undefined {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return s;
  }

  /**
   * Re-hydrate a session recovered from the DB into the in-memory registry
   * (used after a server restart to restore in-flight sessions). Does not
   * overwrite an existing in-memory session with the same ID.
   * completedAt is not persisted to the DB, so it defaults to null for
   * recovered sessions; the TTL sweep will use startedAt as a fallback,
   * which is acceptable for the rare post-restart idempotency window.
   */
  restore(session: UploadSession): void {
    if (!this.sessions.has(session.sessionId)) {
      // Spread session first, then override completedAt to null so that
      // any stale completedAt value from the recovered session is cleared.
      // (Explicit override AFTER spread avoids TS2783 "specified more than once".)
      this.sessions.set(session.sessionId, { ...session, completedAt: null });
    }
  }

  list(): UploadSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}

export const uploadSessions = new UploadSessionRegistry();
