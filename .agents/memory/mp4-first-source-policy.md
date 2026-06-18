---
name: MP4-first source selection policy
description: When faststart is applied, MP4 is the primary broadcast source; HLS is the failover. SQL sourceQuality CASE must stay in sync with toItem() logic.
---

## Rule

When `faststart_applied = true` AND `localVideoUrl IS NOT NULL`, the broadcast orchestrator serves the MP4 directly as the primary source — even when an `hlsMasterUrl` also exists. HLS is wired as the failover only.

When faststart has NOT been applied, HLS remains primary (adaptive bitrate), MP4 as fallback.

**Why:** Direct MP4 Range-request streaming starts instantly (no manifest round-trips), works everywhere without a transcoding pipeline, and is immediately available post-upload. HLS transcoding is an async quality upgrade, not a prerequisite.

## How to apply

### `queue.repo.ts` — `toItem()`
```typescript
const preferMp4Direct = row.faststartApplied === true && !!row.localVideoUrl;
const primary = preferMp4Direct
  ? normalizeQueueUrl(row.localVideoUrl ?? row.hlsMasterUrl)
  : normalizeQueueUrl(row.hlsMasterUrl ?? row.localVideoUrl);
```

### `queue.repo.ts` — `sourceQuality` SQL CASE (must stay in sync with toItem)
```sql
CASE
  WHEN faststartApplied = true AND localVideoUrl IS NOT NULL THEN 'mp4_faststart'
  WHEN hlsMasterUrl IS NOT NULL                             THEN 'hls'
  ELSE 'mp4_raw'
END
```

The `mp4_faststart` branch must come FIRST — before the HLS check — because a video can have both `hlsMasterUrl` and `faststartApplied=true` after the transcoder completes post-upload.

### Mobile V2PlayerContainer quality badge labels
```typescript
const label = sq === "hls" ? "HLS" : sq === "mp4_faststart" ? "MP4" : "SD";
```
(Not "HD"/"SD" — "MP4" accurately describes the direct-streaming mode to operators.)

### Mobile drift guard for MP4
The same `HLS_SMALL_DRIFT_SKIP_MS` (8 s) drift guard that suppresses spurious VOD HLS re-seeks also applies to the MP4 play path. ExoPlayer discards its prefetched byte range on every `playFromPositionAsync`, causing a 100–300 ms rebuffer even for Range-request MP4.

## Known gap

`orchestrator.upgradeItemSource({ quality: "hls" })` (called on HLS transcode completion) sets the in-memory `sourceQuality = "hls"` without changing the source URL. This causes the badge to transiently show "HLS" when MP4 is still playing. Self-corrects within 30 s on the next `reloadInner()` cycle. Acceptable trade-off; do not "fix" by changing the source URL inside upgradeItemSource — that path does not reload the queue and would desync item.source.url.
