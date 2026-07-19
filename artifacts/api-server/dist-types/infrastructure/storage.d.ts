import { Readable } from "node:stream";
/** How many storage read streams are currently open. */
export declare function getActiveStorageStreamCount(): number;
/**
 * Signal the storage layer that the process is shutting down.
 * After this call new stream reads will fail fast instead of blocking.
 */
export declare function signalStorageShutdown(): void;
export interface MultipartPart {
    partNumber: number;
    etag: string;
}
export interface ObjectStorage {
    readonly enabled: boolean;
    readonly bucket: string | null;
    readonly region: string | null;
    putObject(args: {
        key: string;
        body: Buffer | Uint8Array;
        contentType?: string;
    }): Promise<{
        key: string;
        url: string;
    }>;
    getObject(key: string): Promise<{
        body: Readable;
        contentType?: string;
        contentLength?: number;
    }>;
    signedDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;
    signedUploadUrl(args: {
        key: string;
        contentType?: string;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        key: string;
    }>;
    deleteObject(key: string): Promise<void>;
    /**
     * Deletes every blob whose key starts with `prefix`.
     * Returns the number of objects deleted.
     */
    deleteByPrefix(prefix: string): Promise<number>;
    headObject(key: string): Promise<{
        exists: boolean;
        contentLength?: number;
        contentType?: string;
        chunked?: boolean;
        chunkCount?: number;
    }>;
    /**
     * Fetch a byte-range slice of a stored blob.
     * `start` and `end` are 0-indexed, inclusive (matching HTTP Range semantics).
     * Returns null when the key does not exist.
     *
     * Pass `preloadedHead` if you have already called `headObject()` for this key
     * in the same request handler — doing so saves one DB round-trip for chunked blobs.
     */
    getObjectRange(key: string, start: number, end: number, preloadedHead?: {
        exists: boolean;
        contentLength?: number;
        contentType?: string;
        chunked?: boolean;
        chunkCount?: number;
    }): Promise<{
        body: Readable;
        contentType?: string;
        contentLength: number;
    } | null>;
    publicUrl(key: string): string | null;
    createMultipartUpload(args: {
        key: string;
        contentType?: string;
    }): Promise<{
        uploadId: string;
    }>;
    signUploadPart(args: {
        key: string;
        uploadId: string;
        partNumber: number;
        ttlSeconds?: number;
    }): Promise<string>;
    uploadPart(args: {
        key: string;
        uploadId: string;
        partNumber: number;
        body: Buffer;
    }): Promise<{
        etag: string;
    }>;
    /**
     * @param expectedSha256 Optional 64-char lowercase hex SHA-256 of the complete file.
     *   When provided, the assembled blob's SHA-256 is computed server-side inside
     *   PostgreSQL and compared.  Any mismatch causes the transaction to roll back
     *   so no corrupt blob is ever committed to storage_blobs.
     */
    completeMultipartUpload(args: {
        key: string;
        uploadId: string;
        parts: MultipartPart[];
        expectedSha256?: string;
        totalChunks?: number;
        traceContext?: {
            sessionId?: string;
            videoId?: string;
        };
    }): Promise<{
        key: string;
        etag: string | null;
        location: string | null;
    }>;
    abortMultipartUpload(args: {
        key: string;
        uploadId: string;
    }): Promise<void>;
}
export interface StorageStats {
    totalBytes: number;
    totalBlobCount: number;
    lastRefreshedAtMs: number | null;
}
export declare function getStorageStats(): StorageStats;
/**
 * Refresh storage capacity stats from the storage_blobs DB table.
 * Fire-and-forget safe — failures are logged as warn only.
 * Call periodically (e.g. every 5 min) from a supervised background worker.
 */
export declare function refreshStorageStats(): Promise<StorageStats>;
/**
 * Returns the singleton PostgreSQL BYTEA object storage instance.
 *
 * All video assets are stored in the storage_blobs PostgreSQL table.
 * S3_BUCKET / AWS credentials are no longer required.
 */
export declare function storage(): ObjectStorage;
