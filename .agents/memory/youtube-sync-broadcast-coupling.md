---
name: YouTube sync → broadcast queue coupling gaps
description: Three coupling gaps between youtube-sync completion and the broadcast system; patterns for fixing them.
---

## Gap 1 — broadcast-queue-updated not fired after sync
`syncYouTubeChannel()` fired `videos-library-updated` but NOT `broadcast-queue-updated`.
The orchestrator's bus-bridge only listens for `broadcast-queue-updated`, so newly synced
YouTube videos never triggered an orchestrator reload.

**Fix:** After the sync's final DB upsert, also push `adminEventBus.push("broadcast-queue-updated")`.

## Gap 2 — ytShuffleFallback in-memory catalog stale after sync
`YtShuffleFallback.activate()` queries managed_videos at activation time and builds a
Fisher-Yates shuffled playlist. When the fallback is already ACTIVE, new videos synced from
YouTube are never added to the in-memory playlist until deactivation/reactivation.

**Fix:** Added `refreshCatalog()` method to `YtShuffleFallback`. Called from
`syncYouTubeChannel()` after successful sync (inserted > 0 || updated > 0) — fire-and-forget.
Method inserts genuinely new entries (by youtubeId diff) at a random position AFTER the
current playlistIndex, leaving current playback undisturbed.

## Gap 3 — circular dependency risk (none, but note)
youtube-sync → broadcast-v2/engine/youtube-shuffle-fallback: safe direction.
broadcast-orchestrator → scanLibraryAndEnqueue (broadcast/) but NOT → youtube-sync.
No circular dependency — confirmed before import was added.

**How to apply:** After any change that adds YouTube videos to managed_videos (sync, webhook,
manual import), ensure both bus events fire and refreshCatalog() is called.
