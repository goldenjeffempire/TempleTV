---
name: Broadcast queue admission policy — source-availability-only
description: Documents the canonical broadcast queue admission policy: any video with a source URL is eligible regardless of faststart/transcoding status.
---

## Rule
Queue admission depends **only on source availability**, not on faststart status, transcoding outcome, or moov atom position.

**Admit any video with**:
- `localVideoUrl IS NOT NULL` (any non-empty URL)
- OR `hlsMasterUrl IS NOT NULL` (preferred streaming source)

**Exclude only videos with truly absent sources**:
- `transcodingErrorCode = 'CORRUPT_SOURCE'` — moov atom absent, file cannot be decoded
- `transcodingErrorCode = 'SOURCE_MISSING'` — storage blob deleted, no bytes to serve
- `transcodingErrorCode = 'ASSEMBLY_FAILED'` — blob assembly incomplete (upload never committed)
- `videoSource = 'youtube'` — library-only, never enters broadcast queue
- `s3MirroredAt IS NULL` (local videos) — blob not committed yet

**NOT grounds for exclusion**:
- `faststartApplied = false` — moov at EOF but file exists; faststart-recovery worker retries
- `transcodingStatus = 'failed'` — as long as localVideoUrl or hlsMasterUrl is set
- `transcodingErrorCode = 'DISK_FULL'` — transcoding failed but source file intact

**Why:** The original policy (block `failed + faststartApplied=false`) caused "Off Air" windows whenever admin inaction left videos with this status in the queue. The player watchdog + bad-URL cache (20s TTL, 5-skip → in-memory suspension for 5min) + auto-skip handle unrecoverable range-streaming failures gracefully. The faststart-recovery worker actively fixes moov position in the background.

**How to apply:**
- `isPlayableForBroadcast()` in `auto-enqueue.service.ts` — returns true for any video with localVideoUrl (no faststart check)
- `scanLibraryAndEnqueue()` SQL — no longer pre-filters on `faststartApplied = false`
- `loadActive()` in `queue.repo.ts` — `failed` status clause admits when `localVideoUrl OR hlsMasterUrl IS NOT NULL`; `processing` status admitted unconditionally (multipart upload is atomic)
- `queue-integrity-validator.ts` auto-deactivation — only CORRUPT_SOURCE and SOURCE_MISSING deactivate; DISK_FULL and faststartApplied=false are surfaced as "warn" not "error", never deactivated
- `faststart-recovery.ts` — candidate query includes `failed` status (not just `none/queued/encoding`) so the worker proactively fixes moov on all in-queue videos with objectPath

## Validator deactivation criteria (narrowed)
Only two error codes produce DB-level deactivation (`is_active=false`, `validatorDeactivatedReason='corrupt_upload'`):
1. `CORRUPT_SOURCE` — file is structurally unusable
2. `SOURCE_MISSING` — blob is gone from storage

DISK_FULL and faststartApplied=false produce "warn" level diagnostics only — the video stays in broadcast rotation.
