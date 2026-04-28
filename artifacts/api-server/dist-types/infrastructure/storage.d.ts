/**
 * S3-compatible storage abstraction.
 *
 * Works with: AWS S3, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces.
 * Set S3_ENDPOINT to switch providers; leave blank for AWS S3.
 *
 * If S3_BUCKET is not configured the storage layer falls into a
 * disabled-but-callable mode that logs a clear error rather than
 * crashing the process. Production deploys MUST provide S3 credentials.
 */
export interface ObjectStorage {
    readonly enabled: boolean;
    readonly bucket: string | null;
    putObject(args: {
        key: string;
        body: Buffer | Uint8Array;
        contentType?: string;
    }): Promise<{
        key: string;
        url: string;
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
}
export declare function storage(): ObjectStorage;
