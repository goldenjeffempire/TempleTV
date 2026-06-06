---
name: Transcoding pipeline audit sprint 48
description: 4 real bugs fixed in the HLS transcoding pipeline — progress reporting, DISK_FULL validation gap, early stuck-job detection, and admin UI stall indicator.
---

## Bug 1: Progress never reported when durationSecs=null

**Location**: `transcoder.service.ts` — main encode stdout handler (line ~1209) and 360p fallback handler (line ~1369).

**Symptom**: If `probeDurationSecs()` returns null (file corrupt header, ffprobe unavailable), the `if (m && durationSecs && req.onProgress)` guard short-circuits. Admin UI shows 0% stuck forever even while FFmpeg is actively encoding.

**Fix**: Drop `durationSecs` from the guard; add a ternary: when durationSecs is known use `(sec/durationSecs)*90`, otherwise use `(sec/3600)*85` (1-hour fallback, capped at 85% to leave room for the upload phase). Applied identically to both the main path and the 360p fallback path.

## Bug 2: isDiskFull dead-code in UNPLAYABLE_CORRUPT_UPLOAD

**Location**: `queue-integrity-validator.ts` lines ~190 and ~522.

**Symptom**: `isDiskFull = row.vErrCode === "DISK_FULL"` was computed but never included in either the issue-detection condition or the auto-fix filter. A video with DISK_FULL + no HLS + faststartApplied=true stayed active in the broadcast queue, causing perpetual skip cycles. The DISK_FULL branch in the error message was also dead code.

**Fix**: Added `|| isDiskFull` to the condition (line 190) and `|| r.vErrCode === "DISK_FULL"` to the filter (line 522).

## Bug 3: Stuck-job watchdog too slow for common failure modes

**Previous behavior**: watchdog only fired every 5 minutes (`STUCK_JOBS_TICKS=30`) and only caught jobs stuck for > 2h+5min. A job stuck at 2% progress (FFmpeg crashed silently, or hung mid-encode after OOM SIGKILL) would sit for 2+ hours before being reset.

**Fix**: Three-part improvement:
1. `STUCK_JOBS_TICKS` reduced from 30 → 12 (fires every ~2 minutes).
2. **Early-stuck**: `lastProgressAt IS NULL AND startedAt < NOW() - 30min` — catches silent FFmpeg spawn failures.
3. **Stale-progress**: `lastProgressAt < NOW() - 15min AND startedAt < NOW() - 5min` — catches FFmpeg hung mid-encode.
4. Added three static class constants: `EARLY_STUCK_MS=30min`, `PROGRESS_STALE_MS=15min`, `JOB_START_GRACE_MS=5min`.
5. Reset messages now specify which watchdog condition triggered (full timeout / no-progress / stale-progress).
6. `lastProgressAt` is cleared to null when a job is reset (so the next attempt starts fresh).

## Bug 4: lastProgressAt column missing

**Schema**: `lib/db/src/schema/transcoding.ts` — added `lastProgressAt: timestamp("last_progress_at", { withTimezone: true })`.

**Dispatcher**: `onProgress` callback now writes `lastProgressAt: new Date()` alongside `progress`.

**Queue/route**: `listJobs()` and `getJob()` now select `lastProgressAt`; `TranscodingJobSchema` exposes it as `z.string().nullable()`; `projectTranscodingJob` serialises it as ISO string.

## Admin UI stall indicator

**Location**: `artifacts/admin/src/pages/transcoding.tsx`.

- Added `startedAt` and `lastProgressAt` to `TranscodingJob` interface.
- For encoding jobs: if `Date.now() - (lastProgressAt ?? startedAt) > 10min`, show amber "Stalled" badge and warn message "No progress update for N min — watchdog will reset shortly".
- Card gets amber border/background tint when stalled.
- "Started X ago" now uses `startedAt` (not `createdAt`) for encoding jobs; shows "Queued X ago" for queued jobs.

## How to apply

These patterns guard against:
- Progress reporting null-guards: always drop durationSecs from the `if (m && req.onProgress)` guard; apply the fallback ternary.
- isDiskFull dead-code: whenever a new error code is added to managed_videos, check ALL uses of `vErrCode` in queue-integrity-validator for completeness.
- Stuck-job watchdog: use `lastProgressAt` (not just `startedAt`) to detect stalled jobs; early-stuck threshold (30min no progress) is safe for production sermon-length content.
