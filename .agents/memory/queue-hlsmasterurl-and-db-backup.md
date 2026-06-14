---
name: Queue hlsMasterUrl + DB-backed queue backup
description: Two systemic fixes to broadcast queue — hlsMasterUrl written at enqueue time and on HLS completion; /tmp queue backup replaced with broadcast_runtime_state.queue_backup column.
---

## Rule 1: AddQueueItemSchema must include hlsMasterUrl

`AddQueueItemSchema` in `broadcast.schemas.ts` must have `hlsMasterUrl: z.string().max(2048).nullable().optional()`.

Without it, both `broadcast.service.ts` and `auto-enqueue.service.ts` cannot pass the HLS URL through to the DB insert (TS2353 error).

**Why:** The queue row needs `hls_master_url` populated at INSERT time so the orchestrator's source resolver is self-contained (no join to managed_videos required). For MP4-only videos this is null at insert; the transcoder dispatcher UPDATE stamps it after HLS completion.

**How to apply:** Any new field passed through the addToQueue call chain needs to be in this schema first, then broadcast.service.ts `.values({})`, then the caller.

---

## Rule 2: Transcoder dispatcher updates broadcast_queue.hls_master_url on HLS completion

After `UPDATE managed_videos SET transcoding_status='hls_ready'`, also run:
```typescript
await db.update(schema.broadcastQueueTable)
  .set({ hlsMasterUrl: result.masterPlaylistUrl, ...(durationSecs > 10 ? { durationSecs } : {}) })
  .where(eq(schema.broadcastQueueTable.videoId, job.videoId))
  .catch(...)
```

**Why:** Videos enrolled in the queue at upload time (MP4-first) have null `hls_master_url` on the queue row. The COALESCE in loadQueue compensates via a managed_videos join, but the queue row itself is incomplete. Stamping it at HLS-ready time makes the row self-contained and ensures the orchestrator upgrades on next reload without additional queries.

---

## Rule 3: Queue backup — DB-primary, /tmp secondary

`broadcast_runtime_state` has a `queue_backup` jsonb column (added). `runtime.repo.ts` has `saveQueueBackup(channelId, payload)` and `loadQueueBackup(channelId)`.

`BroadcastOrchestrator.saveQueueBackup()` now writes to DB first (fire-and-forget), then /tmp.  
`BroadcastOrchestrator.loadQueueBackup()` tries DB first, then /tmp filesystem, then returns null (OFF_AIR).

**Why:** `/tmp` is ephemeral on Replit and many container environments. The DB-backed backup survives restarts even when broadcast_queue is temporarily unreachable — eliminating the only true local-filesystem dependency in the broadcast pipeline.
