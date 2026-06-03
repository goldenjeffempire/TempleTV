import { Readable } from "node:stream";
/** How many storage read streams are currently open (DB queries in-flight). */
export declare function getActiveStorageStreamCount(): number;
/**
 * Signal the storage layer that the process is shutting down.
 * After this call, `streamChunked` generators exit at the next chunk boundary
 * instead of issuing another SUBSTRING query, preventing the
 * "Cannot use a pool after calling end" crash that occurs when the pool is
 * closed while active streams are still reading.
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
     * Returns the number of rows deleted.
     * Used to purge an entire HLS tree (`transcoded/{videoId}/`) or thumbnail
     * group in a single round-trip.
     */
    deleteByPrefix(prefix: string): Promise<number>;
    headObject(key: string): Promise<{
        exists: boolean;
        contentLength?: number;
        contentType?: string;
    }>;
    /**
     * Fetch a byte-range slice of a stored blob.
     * `start` and `end` are 0-indexed, inclusive (matching HTTP Range semantics).
     * Returns null when the key does not exist.
     */
    getObjectRange(key: string, start: number, end: number): Promise<{
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
    completeMultipartUpload(args: {
        key: string;
        uploadId: string;
        parts: MultipartPart[];
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
export declare function storage(): ObjectStorage;
