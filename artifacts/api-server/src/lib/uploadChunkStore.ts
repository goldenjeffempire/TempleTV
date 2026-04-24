/**
 * Upload chunk + session-metadata persistence layer.
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
 * This module routes chunk + session-metadata storage to Google Cloud Storage
 * (the same bucket used for transcoded HLS output) when the runtime has a
 * bucket configured (`DEFAULT_OBJECT_STORAGE_BUCKET_ID` env var is set, which
 * mirrors the convention used in `transcoder.ts`). When the bucket is not
 * configured (e.g. local dev without object storage), this module reports
 * `isRemoteUploadStoreEnabled === false` and the caller in `routes/admin.ts`
 * falls back to the original local-disk code path verbatim, so dev behaviour
 * is byte-identical to before.
 *
 * Trade-offs of putting chunks in GCS instead of Postgres:
 *   - GCS is the right tool for blob storage: cheap, no row-size cap, no
 *     drag on DB I/O budget, no schema change required.
 *   - The DB stays small and queryable for the structured stuff (videos,
 *     transcoding jobs, sessions, etc.) — it never bloats with 5+ GB of
 *     binary chunks.
 *   - GCS is shared across all Render instances, so a multi-instance API
 *     can recover any session regardless of which container originally
 *     received the chunks.
 *
 * Object layout in the bucket:
 *   uploads/sessions/<sessionId>/session.json     ← metadata (small JSON)
 *   uploads/sessions/<sessionId>/chunk-000000     ← chunk 0
 *   uploads/sessions/<sessionId>/chunk-000001     ← chunk 1
 *   ...
 */

import { objectStorageClient } from "./objectStorage";
import { logger } from "./logger";

const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";

export const isRemoteUploadStoreEnabled: boolean = BUCKET_ID.length > 0;

const SESSION_PREFIX = "uploads/sessions";

function bucket() {
  if (!isRemoteUploadStoreEnabled) {
    throw new Error(
      "uploadChunkStore: remote storage is not enabled — caller must check isRemoteUploadStoreEnabled before invoking remote operations"
    );
  }
  return objectStorageClient.bucket(BUCKET_ID);
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
  await bucket()
    .file(chunkObjectKey(sessionId, chunkIndex))
    .save(buffer, {
      metadata: { contentType: "application/octet-stream" },
      resumable: false,
    });
}

export async function readRemoteChunk(
  sessionId: string,
  chunkIndex: number,
): Promise<Buffer> {
  const [data] = await bucket().file(chunkObjectKey(sessionId, chunkIndex)).download();
  return data;
}

export async function writeRemoteSessionMeta(
  sessionId: string,
  metaJson: string,
): Promise<void> {
  await bucket()
    .file(sessionMetaObjectKey(sessionId))
    .save(metaJson, {
      metadata: { contentType: "application/json" },
      resumable: false,
    });
}

export async function readRemoteSessionMeta(sessionId: string): Promise<string | null> {
  try {
    const [data] = await bucket().file(sessionMetaObjectKey(sessionId)).download();
    return data.toString("utf-8");
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) return null;
    throw err;
  }
}

/**
 * Returns the list of session IDs that currently have a session.json file in
 * the bucket. Used at startup to recover incomplete uploads.
 */
export async function listRemoteSessionIds(): Promise<string[]> {
  const [files] = await bucket().getFiles({ prefix: `${SESSION_PREFIX}/` });
  const ids: string[] = [];
  for (const file of files) {
    const name = file.name;
    if (!name.endsWith("/session.json")) continue;
    // Format: uploads/sessions/<id>/session.json — extract <id>.
    const trimmed = name.slice(`${SESSION_PREFIX}/`.length, -"/session.json".length);
    if (trimmed.length > 0 && !trimmed.includes("/")) {
      ids.push(trimmed);
    }
  }
  return ids;
}

/**
 * Bulk-delete every object under uploads/sessions/<sessionId>/. Best-effort:
 * GCS errors are swallowed and logged, so a failed cleanup never blocks the
 * caller's main flow. Called from session GC, finalize success path, and
 * explicit cancel.
 */
export async function deleteRemoteSession(sessionId: string): Promise<void> {
  if (!isRemoteUploadStoreEnabled) return;
  try {
    await bucket().deleteFiles({ prefix: `${SESSION_PREFIX}/${sessionId}/` });
  } catch (err) {
    logger.warn({ err, sessionId }, "Failed to delete remote upload session objects");
  }
}
