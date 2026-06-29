---
name: Video validation service — e2e pipeline
description: Architecture and key constraints for the video-validation.service.ts implemented in the MP4-only upload pipeline.
---

## What it does
`artifacts/api-server/src/modules/transcoder/video-validation.service.ts` runs 9 checks on every uploaded MP4 (after faststart succeeds):

1. FILE_INTEGRITY — ffprobe reads container/codec info; fails if no streams
2. MOOV_PLACEMENT — `ffprobe -v error -show_entries format_tags` checks `major_brand`; faststart-derived streams are trusted
3. CODEC_COMPAT — video codec must be h264/h265/hevc/vp8/vp9/av1; audio aac/mp3/opus/vorbis/pcm/flac
4. KEYFRAME_INTERVAL — keyframe_interval_frames from `ffprobe -select_streams v:0 -show_packets -read_intervals "%+#200"`; warn if > 10s or > 300 frames
5. AV_SYNC — `ffprobe -show_entries stream=start_time,codec_type` checks audio/video start_time delta; warn if > 500ms, fail if > 2000ms
6. FIRST_FRAME — `ffmpeg -vframes 1 -f null` decode of first frame
7. LAST_FRAME — `ffmpeg -sseof -5 -vframes 1 -f null` decode of last frame
8. DURATION_ACCURACY — compares ffprobe duration vs stored DB duration; warns if > 10% deviation when both are reliable
9. RANGE_SUPPORT — HTTP HEAD + Range: bytes=0-1023 request against the video's own URL; warns if server doesn't return 206

**Status values:** `null` (never run, backward compat) → `pending` → `running` → `passed` / `warn` / `failed`

**Broadcast gate:** `isPlayableForBroadcast()` returns false when `validationStatus === "failed"`. null/passed/warn all allow broadcast.

## DB columns
`managed_videos.validation_status` (text), `.validation_report` (jsonb), `.validation_completed_at` (timestamptz). All three exist in production DB.

## Integration points
- Primary finalize path: `chunked-upload.routes.ts` after faststart succeeds
- Assembly-retry path: `chunked-upload.routes.ts` after assembly retry succeeds
- Faststart-recovery worker: `faststart-recovery.ts` after recovery faststart
- Auto-enqueue gate: `isPlayableForBroadcast()` in `auto-enqueue.service.ts`

## Critical rule: validationStatus in every select
**ALL** `isPlayableForBroadcast()` call sites must include `validationStatus: videosTable.validationStatus` in their Drizzle select. The function accepts `validationStatus?: string | null` so TypeScript won't catch a missing field at compile time — the field simply evaluates as `undefined` and the `=== "failed"` check silently passes. Two confirmed call sites:
- `scanLibraryAndEnqueue()` (~line 336) — fixed ✅
- Primary finalize path select (~line 88) — fixed ✅

**Why:** The field is declared `validationStatus?: string | null` in the function signature so TypeScript treats it as always-optional. A missing select causes undefined → gate bypassed.

## Admin endpoints
- `GET /api/v1/admin/videos/:id/validation` — returns stored report
- `POST /api/v1/admin/videos/:id/validation/run` — triggers new validation; `?sync=true` blocks until complete (30s timeout)

## Resource safety
- All FFmpeg/ffprobe spawns: `proc.unref()` + explicit `SIGKILL` via `setTimeout` per-check (30s budget)
- Total job budget: 180s with outer SIGKILL timer
- Streaming blob download (no full-file buffer) to temp file; `finally` block deletes temp
- Orphan kill: module-level `activePids` Set; SIGKILL on process exit signal
