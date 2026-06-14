---
name: finalizeFromDbFallback multipart abort
description: abortMultipartUpload must be called in catch when db_fallback assembly fails or orphaned _parts rows accumulate permanently
---

## Rule
In `finalizeFromDbFallback`, declare `let assemblyUploadId: string | undefined` BEFORE the try block. Assign it immediately after `createMultipartUpload()` succeeds. In the catch block, call `storage().abortMultipartUpload({ key: objectKey, uploadId: assemblyUploadId })` if `assemblyUploadId` is set.

## Why
`finalizeFromDbFallback` creates its own **temporary** multipart upload for reassembly — distinct from the session's original `uploadId` stored in `sessions.uploadId`. The stale-session cleanup sweep uses `sessions.uploadId`, so it never cleans up the reassembly upload. If any step fails (chunk fetch, SHA-256 mismatch, uploadPart, completeMultipartUpload), the uploadId is inaccessible from the catch block (declared inside try), leaving orphaned `_parts/{uploadId}/...` rows in `storage_blobs` permanently.

## How to apply
Any function that calls `createMultipartUpload()` and does not immediately pass the uploadId to a cleanup-aware system must follow this pattern:
```ts
let uploadId: string | undefined;
try {
  const result = await storage().createMultipartUpload({ key, contentType });
  uploadId = result.uploadId;
  // ... use uploadId ...
  await storage().completeMultipartUpload({ key, uploadId, parts });
} catch (err) {
  if (uploadId) {
    await storage().abortMultipartUpload({ key, uploadId }).catch(() => {});
  }
  throw err;
}
```
