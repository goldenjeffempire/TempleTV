export declare const uploadTelemetry: {
    /**
     * Record session initialisation (multipart slot created, session row inserted).
     * Call immediately after the upload session is successfully persisted.
     */
    init(sessionId: string, sizeBytes: number, userAgent?: string | null): void;
    /**
     * Record a successful finalize: assembly + DB insert completed, video row exists.
     * @param durationMs  Wall-clock milliseconds from assembly start to video row insert.
     */
    success(sessionId: string, videoId: string, sizeBytes: number, durationMs: number): void;
    /**
     * Record a server-side finalize failure (corrupt container, storage HEAD
     * mismatch, DB insert error, assembly watchdog timeout, etc.).
     * @param errorKind  Short machine-readable category (e.g. "corrupt_container",
     *                   "size_mismatch", "db_insert_failed", "assembly_failed").
     */
    serverFail(sessionId: string, sizeBytes: number | null, errorKind: string, errorMessage: string): void;
};
