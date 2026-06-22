---
name: Zero-byte blob storage integrity hardening
description: Four-layer defence against zero-byte blobs in PostgreSQL BYTEA storage — upfront guard, post-assembly guard, immediate detection+deletion in Pass C, and boot-time repair hook.
---

## The problem

Interrupted `putObject` calls can commit the INSERT to `storage_blobs` while writing 0 bytes of actual data. The row exists (`size_bytes=0`) and looks valid to naive existence checks, but serves empty/corrupt content to HLS players.

## Four-layer fix (June 2026)

### Layer 1: putObject upfront guard (`storage.ts`)
Added at the very start of `putObject()`: if `buf.length === 0`, throw `STORAGE_EMPTY_BODY` immediately. No zero-byte row is ever written.

### Layer 2: completeMultipartUpload post-assembly guard (`storage.ts`)
After the `bytea_agg` INSERT, SELECT `size_bytes` from the assembled row. If it's 0 despite `partCount > 0`, DELETE the zero-byte blob and throw. Prevents the fallback `_assemblePartsIterative` path from silently producing a zero-byte blob too.

### Layer 3: Immediate deletion + waterfall in `scanOrphanedBlobs` Phase 3 (`storage-blob-recovery.service.ts`)
Was: log zero-byte blobs, send ops-alert, do nothing.
Now:
1. Fetch the full key list (LIMIT 500).
2. DELETE all zero-byte blobs immediately (not just flag them).
3. Extract videoIds from `transcoded/{videoId}/...` keys.
4. For each affected videoId with an active queue entry, run `runWaterfall()` immediately in a fire-and-forget async block — recovery starts in the same reconciliation pass, not the next 10-min cycle.

### Layer 4: Boot-time repair hook (`broadcast-v2/index.ts`)
In `ensureBroadcastV2Started()` `.then()` callback, a 45-second deferred `setTimeout` runs `storageBlobRecoveryService.runWaterfall()` for a specific video ID (`02d31acf-d200-41e9-ab3d-f08f1a933cac`, "19 5 24 Intro") that experienced a zero-byte blob. The waterfall is idempotent — returns `tier="healthy"` immediately if the asset is already repaired.

**Why:** The waterfall's 6-stage recovery waterfall correctly handles all recovery paths (HLS promotion, variant synthesis, MP4 re-transcode, alt-key resolution, session re-assembly, retry-gated quarantine). The boot hook guarantees the specific asset is repaired on the next restart without manual operator intervention.

## What remains unchanged (already correct)
- Pass A/B of the reconciliation worker already treats `size_bytes=0` as absent (requires `size_bytes > 0` in the batch presence query). These passes still trigger the waterfall for any zero-byte blobs found during their normal check cycle.
- `STORAGE_RECON_SIZE_CHECK` env var (default `true`) controls whether the size gate applies in Pass A/B.
- Per-chunk SHA-256 validation in the chunked upload route (`chunked-upload.routes.ts`) already catches corrupt/empty chunks before they reach `uploadPart()`.

## How to apply
Any future storage corruption that produces zero-byte blobs will be detected at three independent checkpoints (write time, assembly time, reconciliation Phase 3) and deleted + recovered immediately. For targeted repair of a specific video, use `POST /api/broadcast-v2/storage-repair/:videoId`.
