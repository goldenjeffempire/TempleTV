---
name: Pipeline corrupt-upload hardening
description: transcodingErrorMessage column on managed_videos; CORRUPT_SOURCE error code in transcoder; unrecoverable error classification in dispatcher; error surfaced in admin UI.
---

## What was added

### New DB column: `managed_videos.transcoding_error_message TEXT`
- Added to `lib/db/src/schema/videos.ts` (Drizzle schema)
- Added to `db.ts` `ensureUserSchemaColumns` block (idempotent ALTER IF NOT EXISTS)
- Applied via `drizzle-kit push` and confirmed in boot log ("user/auth schema columns ensured")

### Error code `CORRUPT_SOURCE` on thrown errors in `transcoder.service.ts`
- `detectMdatWithoutMoov()` path → `Object.assign(new Error(…), { code: "CORRUPT_SOURCE" })`
- Remux-recovery failure path → same `code: "CORRUPT_SOURCE"`
- Allows the dispatcher to cleanly type-check the failure class without string matching

### Dispatcher unrecoverable classification (`transcoder.dispatcher.ts`)
Two layers:
1. `errCode === "CORRUPT_SOURCE"` — typed, from runTranscode throws
2. Regex pattern match on message — catches errors from ffmpeg stderr that propagate without a typed code:
   `moov atom not found|NO moov atom|unrecoverable|unrepairable|structurally corrupt|corrupt.*re-upload|re-upload.*corrupt|invalid data found when processing|output file is empty.*encoded|no streams were found`

`isCorruptSource` joins `isDiskFull` in the `isImmediateFail` check:
- No retry slot consumed (`attempts` not incremented)
- Job immediately marked `failed`
- `transcodingErrorMessage` written to `managed_videos` (truncated to 2000 chars)

### Error message written at all finalize failure sites (`chunked-upload.routes.ts`)
- Path A early-gate (probeUploadedContainerValidity) — writes "Upload rejected: container validation failed before processing"
- Path A CORRUPT_UPLOAD from faststart — writes "Upload failed: container damaged and unrepairable"
- Path B (db_fallback) early-gate — same message
- Path B CORRUPT_UPLOAD from faststart — same message

### Error message cleared on re-queue (`transcoder.queue.ts`)
- `enqueueTranscode` re-arm path: `{ transcodingStatus: "queued", transcodingErrorMessage: null }`
- Fresh job insert path: same clear

### Admin API (`admin-videos.routes.ts`)
- `VideoRowSchema` now includes `transcodingErrorMessage: z.string().nullable()`
- `toDto()` maps `row.transcodingErrorMessage ?? null`
- No extra DB join — field comes directly from `managed_videos`

### Admin UI (`artifacts/admin/src/pages/videos.tsx`)
- `AdminVideo` interface has `transcodingErrorMessage: string | null`
- Failed video row shows a truncated red text line with AlertTriangle icon below the retry/re-upload badge
- Full message visible on hover (title tooltip)
- Truncated to 160px max-width to avoid layout overflow

## Why
Corrupt uploads previously showed only "failed" status with no diagnostic info.
Operators couldn't distinguish "corrupt file — re-upload" from "disk full — free space and retry"
from "network blip — just retry". The fix gives operators the exact failure reason instantly.

## Existing infrastructure confirmed NOT needing changes
- `probeContainerIsValid` + `detectMdatWithoutMoov` already in `runTranscode` pre-flight ✅
- `CORRUPT_UPLOAD` already thrown by `runFaststart` ✅
- `probeUploadedContainerValidity` early gate already in both finalize paths ✅
- `maxAttempts=5` retry budget already correct ✅
- `ENOSPC`/`EDQUOT` immediate-fail already present ✅
