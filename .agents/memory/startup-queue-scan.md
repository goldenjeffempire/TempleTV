---
name: Broadcast startup library scan
description: Post-boot scanLibraryAndEnqueue ensures all library videos are enrolled in the queue after server restarts
---

## Rule
After `broadcastOrchestrator.start()` resolves, run `repairMissingS3MirroredAt()` + `scanLibraryAndEnqueue({ reason: "startup", maxToAdd: 500 })` as a fire-and-forget task.

## Why
The 60-second reconciler only looks back 24 h. Videos uploaded > 24 h ago whose queue entry was deleted (DB restore, manual intervention) are never recovered by the reconciler — only the 6-hour deep-recovery worker would catch them, with a 10-minute initial delay. The startup scan closes this window immediately on boot.

## How to apply
Already wired in `broadcast-v2/index.ts` inside the `ensureBroadcastV2Started()` post-boot `.then()` block. If adding new post-boot hooks, keep this scan AFTER `queueIntegrityValidator.validate()` but before YouTube auto-override install so it runs with a warm DB connection.

## What it covers
- Queue rows lost during DB restore / manual DELETE
- Videos uploaded > 24 h ago that the reconciler's time window misses
- s3MirroredAt stamps that silently failed on a previous run (repairMissingS3MirroredAt pre-pass)
