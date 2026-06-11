---
name: Production hardening + performance sprint
description: 9 new DB indexes, HLS CDN variant-playlist fix, orchestrator no-op reload hash, TV service worker, admin lazy-image audit
---

## Key decisions

### HLS CDN variant-playlist rewrite (video-serve.routes.ts)
The `isMaster` guard on CDN URL rewriting meant variant playlists (v0/playlist.m3u8) still listed segment URLs pointing at the API origin — CDN was only hit by master manifest clients, not by subsequent segment fetches. Fix: removed `&& isMaster` from both the proxy-path pattern and the S3-URL pattern so ALL manifests get CDN-rewritten.

**Why:** Without this, CDN-enabled deployments had near-zero cache-hit rate for actual segment traffic (the highest-volume requests).

### Orchestrator no-op reload hash (_lastQueueHash in broadcast-orchestrator.ts)
30 s self-heal drift poll fires reloadInner() even when queue is unchanged. Added `_lastQueueHash` (pipe-separated id:durationSecs:localVideoUrl:hlsMasterUrl tuples). If hash matches and queue is non-empty and not a preserveBadUrlCache call → return early. Saves resolveSource() fan-out + rebuildItemOffsets() per drift poll cycle.

**How to apply:** Guards: (1) empty-queue still falls through; (2) preserveBadUrlCache path still falls through; (3) any field change (duration edit, new upload URL) produces a new hash.

### DB indexes added to ensureRuntimeIndexes()
9 new indexes — all use the safe `run()` helper that catches per-index errors:
- `idx_cache_entries_expires_at` — cache eviction sweep
- `idx_refresh_tokens_active_expires` — token purge WHERE revoked_at IS NULL
- `idx_app_versions_platform_channel_active` — mobile OTA version check
- `idx_live_ingest_active_priority` — health dashboard WHERE is_active=true
- `idx_playlists_active_created` — playlist listing
- `idx_prayer_requests_unread` — unread count/listing
- `idx_user_feedback_unread` — unread admin dashboard
- `idx_broadcast_event_log_channel_seq` — SSE replay + pruning
- `idx_s3_telemetry_video_event_created` — telemetry analytics

### TV service worker (artifacts/tv/public/sw.js)
Cache strategies: static assets → cache-first 30d; HLS .ts segments → cache-first 7d immutable; images → stale-while-revalidate 7d; API catalog → network-first with 60 s stale fallback; HLS manifests → passthrough (live content). Skipped on native TV (Tizen/webOS) and in dev. Registered in main.tsx guarded by `import.meta.env.PROD`.

### Admin lazy-image audit
- `loading="lazy" decoding="async"` was already present in library.tsx and broadcast-v2.tsx
- Added to: series.tsx (×2), broadcast.tsx (×4), analytics.tsx (×1)
- TV SermonCard already had loading="lazy"
