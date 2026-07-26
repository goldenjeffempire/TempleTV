---
name: DownloadManager progress throttle — OOM fix
description: Why onProgress must throttle notify() calls and how it's done.
---

## Root cause

`FileSystem.DownloadResumable` fires progress callbacks at native frame rate — effectively
hundreds of times per second on a fast connection. Each callback called `notify()` which
called `getAll()` (array copy of the full item Map) and broadcast to every React subscriber.
On multi-GB downloads with multiple active subscribers this created O(listeners × Hz) object
allocation pressure → OOM on low-memory devices.

## Fix

`DownloadManager` now tracks `_lastProgressNotify: Map<string, number>` per video ID.
`onProgress()` still updates in-memory state immediately on every callback, but only calls
`notify()` when ≥ `PROGRESS_THROTTLE_MS` (250ms) has elapsed since the last notify for that
video. State accuracy is unaffected; UI update rate is capped at 4 fps per download.

**Why**: In-memory state is always fresh; only subscriber broadcast is throttled. Calling
`notify()` too often doesn't improve accuracy — React batches state updates anyway.
