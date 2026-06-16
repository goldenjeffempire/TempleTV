---
name: Video technical metadata pipeline
description: probeVideoMetadata() runs after upload assembly to extract codec/bitrate/resolution; source.upgraded event for gapless HLS promotion detection.
---

## Rule
After upload assembly (both Path A and Path B in `chunked-upload.routes.ts`), call `probeVideoMetadata()` in a background fire-and-forget block. Save `videoCodec`, `audioCodec`, `videoBitrate`, `videoWidth`, `videoHeight` to `managed_videos`. Expose all five + `transcodingProgress` (null placeholder, query from `transcoding_jobs` when live progress needed) in `VideoRowSchema` and `toDto()` in `admin-videos.routes.ts`.

**Why:** Operators need to see source quality at a glance. Probing on assembly (not transcoding) means even MP4-only videos get metadata immediately, before HLS finishes.

## Source upgrade detection
`broadcast-orchestrator.ts` captures `prevPrimaryUrl` before each reload. When it changes from a non-HLS URL to an HLS URL for the currently-playing item, it emits `adminEventBus.push("source-upgraded", {...})` AND pushes `"source.upgraded"` to the V2 event bus. The admin broadcast-v2 page listens via `useSSEEvent("source-upgraded")` and immediately invalidates `broadcast-queue` and `broadcast-v2-engine-health` query keys so sourceKind badges update without a page reload.

**How to apply:**
- New DB columns: `videoCodec`, `audioCodec`, `videoBitrate`, `videoWidth`, `videoHeight` on `managed_videos` (all nullable).
- `probeVideoMetadata()` is exported from `transcoder.service.ts` — single ffprobe pass returning `VideoMetadata | null`.
- `transcodingProgress: null` in `toDto()` — wire to live DB query from `transcoding_jobs` when real-time progress is needed.
- `"source-upgraded"` + `"transcoding-progress"` must be in `KNOWN_EVENTS` and `summarize()` in `sse-context.tsx`.
