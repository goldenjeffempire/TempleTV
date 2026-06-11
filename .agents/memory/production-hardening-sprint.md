---
name: Production hardening sprint — Tasks 1-6
description: Durable fixes from the 6-task production hardening audit across all Temple TV subsystems.
---

# Production Hardening Sprint — Tasks 1-6

## Broadcast orchestrator — restoredCycleAnchor empty-queue preservation

**Rule:** Only null out `this.restoredCycleAnchor` and `this.checkpointSavedAtMs` when `this.items.length > 0`. If the queue is temporarily empty on first reload, the boot anchor must survive to the next reload when items appear.

**Why:** An empty-queue reload consumed the anchor before it could be applied, causing a wrong fresh-start cycle position when items were later added (e.g. after a cold start with slow DB reads).

**How to apply:** In `reloadInner()`, wrap the null-out in `if (this.items.length > 0) { this.restoredCycleAnchor = null; ... }`.

## Health monitor — itemMassivelyOverdue threshold

**Rule:** `itemMassivelyOverdue = elapsedMs > durationMs + Math.max(PLAYBACK_GRACE_MS, durationMs * 1.5)` — not `3 * PLAYBACK_GRACE_MS`.

**Why:** Short clips (< 60 s) would not be classified as "massively overdue" for 9+ minutes (3 × 3 min GRACE) even though they finished in 30 s, blocking the stale-reload tiers.

## Transcoder dispatcher — periodic stuck-job watchdog

**Rule:** Add `setInterval(() => resetStuckJobs(), 10 * 60_000).unref()` in `start()` right after the one-shot `resetOrphanedJobs()`.

**Why:** `resetOrphanedJobs()` only fires at startup. Jobs can become stuck mid-encode in long-running production deployments (SIGKILL race, zombie ffmpeg, DB write timeout). The periodic watchdog increments attempts → permanently fails jobs that repeatedly time out.

## Mobile — didJustFinish positionMillis > 0 guard

**Rule:** Gate the entire `if (status.didJustFinish)` block with `&& (status.positionMillis ?? 0) > 0`.

**Why:** ExoPlayer can fire `didJustFinish` at `positionMillis = 0` before reporting any playback position (stale seek on newly-loaded manifest). Processing a finish with zero position misclassifies it and triggers retry logic.

## Mobile — HLS_QUICK_FINISH_THRESHOLD_MS lowered

**Rule:** `HLS_QUICK_FINISH_THRESHOLD_MS = 3_000` (was 5 000). `HLS_END_GUARD_MS = 8_000` provides a 5 s clearance above the new threshold, so clamped seeks can never land within the 3 s window.

**Why:** Genuine 4–5 s streams were being incorrectly classified as spurious "quick finishes", triggering needless retries on valid short-form content.

## Mobile — stall-report jitter (react-native.ts)

**Rule:** Wrap `fetch(/report-stall)` in `new Promise(resolve => setTimeout(resolve, Math.random() * 5_000)).then(...)` to add 0–5 s random jitter per device.

**Why:** A mass CDN failure that stalls thousands of devices simultaneously produces a thundering herd on POST /report-stall without jitter, exhausting the server rate-limiter.

## iOS — heartbeat-absence watchdog

**Rule:** Add a `setInterval(30_000)` in `useBroadcastSync` that checks `Date.now() - lastHeartbeatMsRef.current > 30_000` and bumps `reconnectKey` to force WS reconnect on heartbeat absence.

**Why:** iOS 16+ aggressively prunes TCP connections without firing AppState changes. The existing background-detect logic misses half-open zombies that stay foreground while losing connectivity.

## TV — VRAM cap for constrained chipsets

**Rule:** Detect constrained TV at HLS init: `jsHeapSizeLimit ≤ 256 MiB OR Tizen/webOS UA year ≤ 2019`. On constrained devices set `maxBufferLength: 20, maxMaxBufferLength: 20` (vs. 30/60 on modern sets).

**Why:** 2017–2019 Tizen/webOS chipsets keep YUV textures in GPU VRAM proportional to buffer length. 30 s forward buffer causes VRAM exhaustion after 2–3 hours of 24/7 broadcast.

## TV — fullscreen quality-lock: ResizeObserver over double-rAF

**Rule:** In `onFsChange`, use `new ResizeObserver(() => { ro.disconnect(); hls.currentLevel = -1; }).observe(video)` with `typeof ResizeObserver !== "undefined"` guard; fall back to double-rAF only when unavailable (old Tizen 2.x).

**Why:** Double-rAF timing is browser-dependent and can be shorter than the actual fullscreen layout commit on Tizen/webOS slower layout pipelines. ResizeObserver fires exactly when the element's bounding box reflects the new fullscreen dimensions.
