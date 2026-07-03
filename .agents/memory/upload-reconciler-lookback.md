---
name: Upload reconciler lookback window
description: uploadQueueReconciler was limited to 24h; widened to 7 days.
---

## Rule
`uploadQueueReconciler.scan()` must look back far enough to catch uploads that slipped the primary enqueue path more than a day ago.

## Why 24h was too narrow
The 24-hour window assumed all missed uploads would be caught within a day. But if a server crashed at the exact moment between `completeMultipartUpload` and `enqueueIfMissing`, the upload would have `s3MirroredAt IS NOT NULL` (blob committed) but no active queue row. After 24 hours, the reconciler's window would slide past it — and `scanLibraryAndEnqueue()` (the other backstop) only fires when the queue is **empty**, not when one specific video is missing from an otherwise-populated queue.

## Fix
`LOOKBACK_MS` changed from `24 * 60 * 60 * 1000` (24h) to `7 * 24 * 60 * 60 * 1000` (7 days).

**Why 7 days is safe:** The query is guarded by `isNotNull(s3MirroredAt)` + NOT EXISTS active queue row, so widening the window only considers already-assembled, confirmed videos that aren't queued. No performance concern because the `imported_at` column is indexed.

## Location
`artifacts/api-server/src/modules/broadcast/upload-queue-reconciler.ts`
