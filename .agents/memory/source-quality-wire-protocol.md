---
name: sourceQuality wire protocol
description: How V2Item.sourceQuality flows from DB → orchestrator → wire → all clients; where source-upgraded SSE is emitted.
---

## Rule
`V2Item.sourceQuality` is an optional field (`"hls" | "mp4_faststart" | "mp4_raw"`) that must be kept in sync between two files:
- `artifacts/api-server/src/modules/broadcast-v2/domain/types.ts` (server canonical)
- `lib/player-core/src/types.ts` (client mirror — kept manually in sync)

**Why:** player-core has no build-time dep on api-server types; it has its own local copy. Forgetting to update both causes TypeScript errors only on the api-server side and silent missing fields on the client.

## Derivation (orchestrator reloadInner)
```typescript
sourceQuality: v2.source.kind === "hls"
  ? "hls"
  : (row.faststartApplied ? "mp4_faststart" : "mp4_raw")
```
`row.faststartApplied` comes from `RawQueueRow` (populated by `loadActive()` via the `managed_videos.faststart_applied` column). Falls back to `false` on old DBs missing the column (42703 SQLSTATE guard in queue.repo.ts).

## Pass-through in projectItem()
Must include `sourceQuality` in BOTH return paths of `projectItem()`:
1. Failover path (primary bad-URL blocked, serving via failoverSource): derive from `fo.kind` + `item.sourceQuality`
2. Normal path: just pass `item.sourceQuality` through

## source-upgraded SSE event
- Event name on both server and client: `"source-upgraded"` (NOT `"broadcast-source-upgraded"`)
- Already in `KNOWN_EVENTS` in sse-context.tsx and handled by `summarize()`
- Emitted by:
  1. Orchestrator (`reloadInner` lines ~1861-1893) — when currently-playing item's source URL/kind changes
  2. `faststart.service.ts` — after successful faststart completion (`newKind: "mp4_faststart"`)
  3. `transcoder.dispatcher.ts` — after HLS ready (`newKind: "hls"`)
- The orchestrator emission covers the currently-playing item; faststart/transcoder emit for ALL items that finish transcoding

## Admin UI quality badges
Derived from `transcodingStatus` (not sourceQuality directly since queue REST returns transcodingStatus):
- `hasHls` → "HLS" badge (emerald)
- `transcodingStatus === "ready"` → "MP4 only" badge (faststart done, no HLS)
- `transcodingStatus === "none" || null` → "Raw MP4" badge (no faststart yet)
- `transcodingStatus === "encoding"` → "Encoding X%" with progress bar
- `transcodingStatus === "queued"` → "HLS queued"
- `transcodingStatus === "failed"` → destructive badge with retry/re-upload
- `transcodingStatus === "processing"` → "Preparing…" (faststart running)

**Why:** `BroadcastQueueRow` (admin page interface) does not expose `faststartApplied`; quality is inferred from transcoding status instead.
