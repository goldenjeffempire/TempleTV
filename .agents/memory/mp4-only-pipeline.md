---
name: MP4-only pipeline — HLS removal
description: Key constraints and gotchas from switching to MP4-only broadcast with HLS fully stripped out.
---

## Rules

**`broadcastQueueTable` has no `hlsMasterUrl` column.** Only `managed_videos` (`videosTable`) has `hls_master_url`. Any Drizzle select or raw SQL that references `bq.hls_master_url` or `q.hlsMasterUrl` (where `q = schema.broadcastQueueTable`) gets `undefined`, causing Drizzle's `orderSelectedFields` to throw "Cannot convert undefined or null to object" — a non-fatal crash that silently skips the entire validation run.

**Where this has been seen:**
- `queue-integrity-validator.ts` — `qHlsUrl: q.hlsMasterUrl` in the select (fixed: removed)
- `queue-health-guard.ts` — `bq.hls_master_url IS NOT NULL` in raw SQL re-enable query (fixed: removed)

**Why:** `broadcast_queue` schema was always MP4-only at the DB level. The HLS columns were only on `managed_videos`. References to them on the queue table were dead code that Drizzle silently turned into `undefined`.

**How to apply:** Before adding any column reference on `broadcastQueueTable` or `broadcast_queue` raw SQL, verify the column exists in `lib/db/src/schema/broadcast-queue.ts`. Do not assume HLS columns exist there.

## HLS removal scope (completed)

| Location | Change |
|---|---|
| `universal-source-resolver.ts` | Removed `"hls"` branch from `classify()`; `ResolvedSource.failoverSource` now `"mp4"` only |
| `broadcast-orchestrator.ts` | `CachedQueueItem.sourceQuality` type: `"mp4_faststart"\|"mp4_raw"` (no `"hls"`) |
| `broadcast-v2/index.ts` | Removed storage-blob-recovery + queue-self-healing worker spawns; removed unused `db`, `schema`, `eq`, `and` imports |
| `queue-integrity-validator.ts` | Removed `qHlsUrl`/`vHlsUrl` from select; `hasAnyUrl` = `qLocalUrl || vLocalUrl` only |
| `queue-health-guard.ts` | Removed `bq.hls_master_url IS NOT NULL` from re-enable SQL |
| `rest.routes.ts` | `RemediationIssue.sourceQuality` type: `"mp4_faststart"\|"mp4_raw"\|null` (no `"hls"`) |
| `HlsVideoPlayer.tsx` (TV) | Rewritten as pure MP4 A/B dual-buffer player (no hls.js) |
| `LiveBroadcastV2.tsx` (TV) | **Intentionally keeps hls.js** — YouTube Live streams are HLS from Google's servers |

## Start API workflow flags

`TRANSCODER_DISABLE=1` and `TRANSCODING_AUTO_RETRY_DISABLE=1` are set in the Start API workflow. Do not remove them.
