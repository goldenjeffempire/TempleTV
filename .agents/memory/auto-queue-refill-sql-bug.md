---
name: Auto-queue refill SQL transcoding_status values
description: The auto-queue refill worker used wrong status values that never matched, silently returning zero candidates every cycle.
---

## The bug
`auto-queue-refill.ts` queried `transcoding_status IN ('done', 'faststart_applied', 'none')`.
Neither `'done'` nor `'faststart_applied'` are valid values — they don't exist in the DB.

**Valid enum values:** `'none', 'queued', 'encoding', 'processing', 'ready', 'hls_ready', 'failed'`

## Fix
Change to `IN ('ready', 'hls_ready', 'none')` — also add `AND mv.video_source != 'youtube'`
since YouTube videos are served exclusively through the ytShuffleFallback override mechanism
and must never be inserted into broadcast_queue directly by auto-refill.

**Why:** Without this fix, auto-refill logs `"no eligible library videos to add"` on every
90 s cycle even when the library has fully-transcoded local videos, causing the queue to go
empty and trigger dead-air / ops-alert flood.

**How to apply:** Any time the auto-refill unexpectedly finds zero candidates despite a
non-empty library, check transcoding_status values against the actual enum first.
