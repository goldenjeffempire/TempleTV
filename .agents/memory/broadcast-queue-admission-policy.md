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

## All 8 files / functions that enforce this policy

1. **`isPlayableForBroadcast()`** in `auto-enqueue.service.ts` — returns true for any video with localVideoUrl (no faststart check)
2. **`scanLibraryAndEnqueue()` SQL** in `auto-enqueue.service.ts` — pre-filters only CORRUPT_SOURCE/SOURCE_MISSING/ASSEMBLY_FAILED, no faststart filter
3. **`loadActive()` `failed` clause** in `queue.repo.ts` — admits when `localVideoUrl OR hlsMasterUrl IS NOT NULL`
4. **`loadActive()` `processing` clause** in `queue.repo.ts` — admitted unconditionally (blob is atomic)
5. **Validator forward pass** in `queue-integrity-validator.ts` — only deactivates CORRUPT_SOURCE and SOURCE_MISSING
6. **Validator `corrupt_upload` reverse pass** in `queue-integrity-validator.ts` — re-activates when `ANY URL IS NOT NULL AND errorCode NOT IN (CORRUPT_SOURCE, SOURCE_MISSING)`; previously blocked `faststartApplied=false` items permanently
7. **Orphan healer** in `queue-integrity-validator.ts` — DISK_FULL and `faststartApplied=false` items are NOT terminal; removed from isTerminal check; source blob exists → re-transcoding can recover
8. **`reactivateSystemDeactivated()`** in `queue-health-guard.ts` — uses JOIN to managed_videos; only re-enables items with a URL AND not CORRUPT_SOURCE/SOURCE_MISSING/ASSEMBLY_FAILED; prevents the oscillation cycle where CORRUPT_SOURCE items were re-enabled then immediately re-deactivated every 2–3 min

## Validator deactivation criteria (narrowed)
Only two error codes produce DB-level deactivation (`is_active=false`, `validatorDeactivatedReason='corrupt_upload'`):
1. `CORRUPT_SOURCE` — file is structurally unusable
2. `SOURCE_MISSING` — blob is gone from storage

DISK_FULL and faststartApplied=false produce "warn" level diagnostics only — the video stays in broadcast rotation.

## Oscillation prevention
`reactivateSystemDeactivated()` in queue-health-guard MUST use the JOIN condition or it oscillates:
- Health guard (every 3 min): re-enables ALL validatorDeactivatedReason IS NOT NULL items
- Validator (every 2 min): re-deactivates CORRUPT_SOURCE items
- Result without the fix: every CORRUPT_SOURCE item oscillates every 2–3 min

Fix: JOIN managed_videos and only re-enable when URL IS NOT NULL AND errorCode NOT IN (CORRUPT_SOURCE, SOURCE_MISSING, ASSEMBLY_FAILED).
