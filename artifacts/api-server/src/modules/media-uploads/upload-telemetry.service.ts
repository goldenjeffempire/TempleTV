/**
 * S3 upload telemetry — fire-and-forget event recorder.
 *
 * Records server-side upload lifecycle events into the `s3_upload_telemetry`
 * table so the admin Operations tab can surface accurate success rates,
 * throughput percentiles, and error breakdowns — distinct from the raw
 * `upload_sessions` count which only tracks session state, not outcome.
 *
 * All methods are fully non-blocking (void Promise). Failures are logged at
 * debug level and swallowed so telemetry bugs can never break the upload path.
 */
import { randomUUID } from "node:crypto";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";

export const uploadTelemetry = {
  /**
   * Record session initialisation (multipart slot created, session row inserted).
   * Call immediately after the upload session is successfully persisted.
   */
  init(sessionId: string, sizeBytes: number, userAgent?: string | null): void {
    void db
      .insert(schema.s3UploadTelemetryTable)
      .values({
        id: randomUUID(),
        sessionId,
        event: "init",
        sizeBytes,
        userAgent: userAgent ?? null,
      })
      .catch((err: unknown) => {
        logger.debug({ err, sessionId }, "[upload-telemetry] init insert failed (non-fatal)");
      });
  },

  /**
   * Record a successful finalize: assembly + DB insert completed, video row exists.
   * @param durationMs  Wall-clock milliseconds from assembly start to video row insert.
   */
  success(sessionId: string, videoId: string, sizeBytes: number, durationMs: number): void {
    const throughputBps =
      durationMs > 0 ? Math.round((sizeBytes * 1_000) / durationMs) : null;
    void db
      .insert(schema.s3UploadTelemetryTable)
      .values({
        id: randomUUID(),
        sessionId,
        videoId,
        event: "success",
        sizeBytes,
        durationMs,
        throughputBps,
      })
      .catch((err: unknown) => {
        logger.debug({ err, sessionId }, "[upload-telemetry] success insert failed (non-fatal)");
      });
  },

  /**
   * Record a server-side finalize failure (corrupt container, storage HEAD
   * mismatch, DB insert error, assembly watchdog timeout, etc.).
   * @param errorKind  Short machine-readable category (e.g. "corrupt_container",
   *                   "size_mismatch", "db_insert_failed", "assembly_failed").
   */
  serverFail(
    sessionId: string,
    sizeBytes: number | null,
    errorKind: string,
    errorMessage: string,
  ): void {
    void db
      .insert(schema.s3UploadTelemetryTable)
      .values({
        id: randomUUID(),
        sessionId,
        event: "server_fail",
        sizeBytes,
        errorKind,
        errorMessage: errorMessage.slice(0, 500),
      })
      .catch((err: unknown) => {
        logger.debug({ err, sessionId }, "[upload-telemetry] server_fail insert failed (non-fatal)");
      });
  },
};
