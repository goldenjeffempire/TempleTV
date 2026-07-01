---
name: s3_mirrored_at repair must key off object_path
description: Why some uploaded MP4s get stuck "not broadcast-ready — blob stamp is missing" and never recover.
---

# `s3_mirrored_at` blob-stamp repair must prefer `object_path`

`isPlayableForBroadcast()` gates local videos on `s3_mirrored_at IS NOT NULL`
(proof the BYTEA blob was committed to `storage_blobs`). If that post-assembly
stamp silently fails, the video is excluded from the broadcast queue and the
manual "Sync to Queue" (force-enqueue) returns
"not yet broadcast-ready — blob stamp is missing".

**The trap:** the self-healing `repairMissingS3MirroredAt()` derived the storage
key **only** from `localVideoUrl`, while `auditMissingBlobs()` prefers
`object_path` (the authoritative key written at upload). So a video whose blob
IS present under its `object_path` key, but whose `localVideoUrl` derives a
different/null key, was **never** re-stamped — permanently stuck.

**Rule:** any code that maps a managed video row → its `storage_blobs` key must
prefer `object_path` and fall back to URL derivation:
`objectPath?.trim() || deriveStorageKeyFromUrl(localVideoUrl)`. Keep
`repairMissingS3MirroredAt` and `auditMissingBlobs` using the **same** key
derivation, or they disagree about which blobs exist.

**How to apply:** `repairMissingS3MirroredAt(videoId?)` accepts an optional id to
scope the scan to one row (used by force-enqueue's repair-then-retry on
`not-yet-playable`, so the interactive path touches one blob key, not up to 500).

**Why:** the blob genuinely exists; only the stamp is missing. Keying off the URL
alone makes recovery impossible for the affected rows and blocks them from
broadcast forever.
