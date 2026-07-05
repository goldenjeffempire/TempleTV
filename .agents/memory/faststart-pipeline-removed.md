---
name: FastStart pipeline fully removed
description: All FastStart code removed from admin + API; MP4-only pipeline; DB columns dropped; push-force required for column drops.
---

## Rule
FastStart (moov-atom relocation) is completely gone. Raw MP4 is broadcast-eligible immediately after upload. Do not add faststart back.

**Why:** Platform is YouTube-only (960 videos) with no local uploads active. FastStart was dead code. MP4-only pipeline — upload → s3MirroredAt stamp → enqueueIfMissing → broadcast.

## What was removed
- `faststart_applied` and `faststart_attempts` DB columns (dropped via push-force)
- `'processing'` from `transcodingStatus` CHECK constraint in Drizzle schema
- `/videos/:id/faststart` and `/videos/faststart-all` admin API routes
- `faststartApplied` from: SAFE_VIDEO_COLS, VideoRowSchema, toDto(), all Drizzle .select() calls
- All frontend: `PipelineStage "faststart"`, `faststartMutation`, `bulkFaststartAllMutation`, `faststartPendingIds`, progress pills, Optimise All button, BroadcastReadyBadge faststartApplied prop

## What remains (intentional, safe)
- `queue.repo.ts` `RawQueueRow.faststartApplied` field — hardcoded to `false` via `sql<boolean>\`false\`` in buildQuery; informational only, not used by orchestrator
- `video-validation.service.ts` `checkMoovPlacement` — now uses `faststartApplied: null` always; function kept for moov-placement probe
- Raw SQL queries in `rest.routes.ts` that select `v.faststart_applied` — column no longer in DB so these return NULL (safe)
- Comments/JSDoc referencing faststart — cosmetic, not functional

## Build notes
- `drizzle-kit push` requires `push-force` to drop columns without interactive prompt; `.replit` workflow now uses `push-force`
- Both deployment `run` and `build` commands updated to use `push-force`
