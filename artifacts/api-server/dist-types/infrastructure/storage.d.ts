import { Readable } from "node:stream";
/**
 * Database-backed binary object storage.
 *
 * All video assets — source uploads, HLS segments, playlists, thumbnails,
 * and multipart-upload temp parts — are stored as BYTEA rows in the
 * `storage_blobs` PostgreSQL table. PostgreSQL's TOAST mechanism
 * automatically compresses and fragments large values (> ~2 KiB) without
 * any application-layer intervention, keeping the main table row small
 * while the actual bytes live in a TOAST sub-table.
 *
 * Key design notes (mirroring the previous Replit Object Storage layer):
 *   - No presigned URLs — browser-direct uploads are not supported. All
 *     video data flows through the server-relay chunked upload path.
 *   - Multipart is emulated: createMultipartUpload stores a _meta/{uploadId}
 *     record, uploadPart stores parts under `_parts/{uploadId}/{000001}`,
 *     and completeMultipartUpload assembles them in order using PostgreSQL's
 *     bytea || operator (DB-side concat — no video bytes enter Node.js
 *     memory during finalization), upserts the final key, and cleans up
 *     the temp rows.
 *   - publicUrl / signedDownloadUrl both return the internal proxy path
 *     (`/api/v1/uploads/{key}`) so the video-serve routes stream bytes
 *     directly from the database — zero external dependencies.
 *   - Zero dependency on Replit Object Storage or any cloud provider.
 *
 * Storage key conventions:
 *   uploads/{yyyy}/{mm}/{dd}/{sessionId}.{ext}  — assembled source video
 *   transcoded/{videoId}/master.m3u8            — HLS master playlist
 *   transcoded/{videoId}/v0/playlist.m3u8       — rendition playlist
 *   transcoded/{videoId}/v0/seg_00001.ts        — MPEG-TS segment
 *   transcoded/{videoId}/thumbnail.jpg          — auto-generated thumbnail
 *   thumbnails/{sessionId}.{ext}                — custom uploaded thumbnail
 *   _parts/{uploadId}/{partNumber:06d}          — multipart temp parts
 *   _meta/{uploadId}                            — multipart content-type metadata
 */
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
    headObject(key: string): Promise<{
        exists: boolean;
        contentLength?: number;
        contentType?: string;
    }>;
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
