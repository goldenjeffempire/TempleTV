/**
 * Upload chunk + session-metadata persistence layer (AWS S3 backend).
 *
 * Why this exists:
 * Render's container filesystem is ephemeral — when the container restarts
 * (deploy, OOM, scaling event), every chunk that an operator already uploaded
 * is silently destroyed and the upload UI restarts from 0%. Worse, if an
 * upload was 90% done when the container died, the operator has to re-upload
 * the whole file. The previous implementation flushed a small JSON metadata
 * file to disk for crash recovery, but the chunks themselves were also on
 * the same ephemeral disk so the recovery was cosmetic — the chunks were
 * gone too.
 *
 * This module routes chunk + session-metadata storage to AWS S3 (the same
 * bucket used for transcoded HLS output) when the runtime has S3 configured
 * (`AWS_S3_BUCKET` + credentials present, surfaced via `isS3Configured()`).
 * When S3 is not configured (e.g. local dev without object storage), this
 * module reports `isRemoteUploadStoreEnabled === false` and the caller in
 * `routes/admin.ts` falls back to the original local-disk code path
 * verbatim, so dev behaviour is byte-identical to before.
 *
 * Trade-offs of putting chunks in S3 instead of Postgres:
 *   - S3 is the right tool for blob storage: cheap, no row-size cap, no
 *     drag on DB I/O budget, no schema change required.
 *   - The DB stays small and queryable for the structured stuff (videos,
 *     transcoding jobs, sessions, etc.) — it never bloats with 5+ GB of
 *     binary chunks.
 *   - S3 is shared across all Render instances, so a multi-instance API
 *     can recover any session regardless of which container originally
 *     received the chunks.
 *
 * Object layout in the bucket:
 *   uploads/sessions/<sessionId>/session.json     ← metadata (small JSON)
 *   uploads/sessions/<sessionId>/chunk-000000     ← chunk 0
 *   uploads/sessions/<sessionId>/chunk-000001     ← chunk 1
 *   ...
 */

import {
  deleteObjectsByPrefix,
  getObjectBuffer,
  isS3Configured,
  listObjectKeys,
  putObject,
} from "./s3Storage";

export const isRemoteUploadStoreEnabled: boolean = isS3Configured();

const SESSION_PREFIX = "uploads/sessions";

function ensureEnabled(): void {
  if (!isRemoteUploadStoreEnabled) {
    throw new Error(
      "uploadChunkStore: remote storage is not enabled — caller must check " +
        "isRemoteUploadStoreEnabled before invoking remote operations",
    );
  }
}

export function chunkObjectKey(sessionId: string, chunkIndex: number): string {
  return `${SESSION_PREFIX}/${sessionId}/chunk-${String(chunkIndex).padStart(6, "0")}`;
}

export function sessionMetaObjectKey(sessionId: string): string {
  return `${SESSION_PREFIX}/${sessionId}/session.json`;
}

export async function writeRemoteChunk(
  sessionId: string,
  chunkIndex: number,
  buffer: Buffer,
): Promise<void> {
  ensureEnabled();
  await putObject(chunkObjectKey(sessionId, chunkIndex), buffer, {
    contentType: "application/octet-stream",
  });
}

export async function readRemoteChunk(
  sessionId: string,
  chunkIndex: number,
): Promise<Buffer> {
  ensureEnabled();
  const buf = await getObjectBuffer(chunkObjectKey(sessionId, chunkIndex));
  if (!buf) {
    throw new Error(
      `Chunk not found: session=${sessionId} index=${chunkIndex}`,
    );
  }
  return buf;
}

export async function writeRemoteSessionMeta(
  sessionId: string,
  metaJson: string,
): Promise<void> {
  ensureEnabled();
  await putObject(sessionMetaObjectKey(sessionId), metaJson, {
    contentType: "application/json",
  });
}

export async function readRemoteSessionMeta(
  sessionId: string,
): Promise<string | null> {
  ensureEnabled();
  const buf = await getObjectBuffer(sessionMetaObjectKey(sessionId));
  if (!buf) return null;
  return buf.toString("utf-8");
}

/**
 * Returns the list of session IDs that currently have a session.json file in
 * the bucket. Used at startup to recover incomplete uploads.
 */
export async function listRemoteSessionIds(): Promise<string[]> {
  ensureEnabled();
  const keys = await listObjectKeys(`${SESSION_PREFIX}/`);
  const ids: string[] = [];
  for (const name of keys) {
    if (!name.endsWith("/session.json")) continue;
    // Format: uploads/sessions/<id>/session.json — extract <id>.
    const trimmed = name.slice(
      `${SESSION_PREFIX}/`.length,
      -"/session.json".length,
    );
    if (trimmed.length > 0 && !trimmed.includes("/")) {
      ids.push(trimmed);
    }
  }
  return ids;
}

/**
 * Bulk-delete every object under uploads/sessions/<sessionId>/. Best-effort:
 * S3 errors are swallowed and logged inside `deleteObjectsByPrefix`, so a
 * failed cleanup never blocks the caller's main flow. Called from session
 * GC, finalize success path, and explicit cancel.
 */
export async function deleteRemoteSession(sessionId: string): Promise<void> {
  if (!isRemoteUploadStoreEnabled) return;
  await deleteObjectsByPrefix(`${SESSION_PREFIX}/${sessionId}/`);
}
