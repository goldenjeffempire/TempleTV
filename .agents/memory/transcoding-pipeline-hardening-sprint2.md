---
name: Transcoding pipeline hardening — sprint 2
description: 8 targeted production fixes across the HLS transcoding pipeline (dispatcher, service, queue-health-guard). All build-clean and verified in prod logs.
---

## Rule
When editing the transcoding pipeline, always check all 8 of these invariants:

1. **Scratch dir purge window is 6h** (not 1h) — `purgeOrphanedScratchDirs()` in dispatcher.ts. 1h window deletes active 4K encode scratch dirs mid-job on replicas.

2. **Faststart orphan watchdog threshold is 90 min** (not 45 min) — `resetFaststartOrphans()` in dispatcher.ts. 45 min falsely resets large files still in ffprobe/faststart phase, causing reset loops.

3. **`buildFfmpegArgs` accepts a `threads` param** — 6th argument defaults to `env.TRANSCODER_THREADS`. Both call sites inside `runTranscode` must pass `req.threads ?? env.TRANSCODER_THREADS`.

4. **`TranscodeRequest` has `threads?: number`** — dispatcher computes `Math.max(1, Math.floor(env.TRANSCODER_THREADS / this.activeJobs.size))` at dispatch time so concurrent jobs share the thread budget rather than each claiming the full count.

5. **`injectCodecsIntoMaster` has 3-level fallback** — exact WxH match → height-only match → nearest-height match → catch-all `avc1.4D4028`. Never silently omits CODECS (causes Tizen/webOS black screens).

6. **H264_LEVEL_HEX includes 4.2, 5.0, 5.1, 5.2** — prevents fallback emitting wrong level for edge-case 60fps/4K sources.

7. **Storage circuit breaker outer catch excludes source-missing** — `isSourceMissingPreClaim` guard prevents 404/object-not-found errors from incrementing the infrastructure-outage streak and falsely pausing all job dispatch.

8. **Queue health guard logs INFO (not WARN) when ytShuffleFallback.isActive** — YouTube-only deployments always have 0 local HLS videos; WARN is a false positive there. Import `./youtube-shuffle-fallback.js` and check `ytShuffleFallback.isActive` (getter, no `()`).

**Why:** These were identified via production audit — the bugs caused false circuit-breaker trips, premature scratch dir deletion, black screens on Smart TVs, event-loop starvation under concurrent transcoding, and log noise flooding ops inboxes.

**How to apply:** Any future work on transcoder.dispatcher.ts, transcoder.service.ts, or queue-health-guard.ts should verify all 8 invariants still hold before shipping.
