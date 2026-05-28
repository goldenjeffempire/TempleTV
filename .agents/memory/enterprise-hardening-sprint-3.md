---
name: Enterprise hardening sprint 3
description: 16-task hardening sweep across transcoder, orchestrator, mobile, and admin — May 2026
---

## Rules & constraints confirmed

**Orchestrator durationSecs floor (T004)**
- `CachedQueueItem.durationSecs` now has a 60 s minimum floor applied at load time.
- A 0-second item caused a rapid-skip storm (orchestrator advanced past it on every tick).
- Warn log fires when the floor is applied so operators know which item needs fixing.

**Orchestrator all-blocked state logging (T005)**
- `allBlockedSinceMs` entry now emits `logger.warn` + `bump("all_sources_blocked", ...)` on the first tick where every source URL is blocked.
- `"all_sources_blocked"` added to `V2EventType` union in `domain/types.ts`.
- **Why:** Previously the all-blocked condition was only visible in the TTL-expiry log; operators had no real-time warning of when it started.

**Checkpoint recovery staleness guard (T016)**
- Checkpoint fallback in `reloadInner()` now checks: if `reloadNow - anchor > cycleDurationMs` the checkpoint is stale (server was down longer than one full cycle). Logs a warn and starts fresh.
- Orphaned checkpoint (item no longer in active queue) now logs a warn instead of silently falling to fresh start.
- **Why:** Stale checkpoints caused wrong cycle anchors — items aired in the wrong order after long downtime.

**YoutubePlayer iframe onError (T009)**
- `YoutubePlayer.tsx` (web/RN-web) now passes `onError: () => callbacksRef.current.onError?.()` to the iframe element.
- Covers pre-bootstrap failures (network, CSP, sandbox) that the IFrame Player API's postMessage `onError` never fires for.

**PersistentAudioPlayer onError (T008)**
- `PersistentAudioPlayer.tsx` now passes `onError={advanceToNext}` so a failed background iframe advances to the next sermon instead of silently stalling.

**Transcoder upscaling fix (T001/T003)**
- When resolution probe fails, fallback is capped to 360p only (not 360p + 480p + 720p), preventing upscaling unknown-resolution sources.
- Outer-catch of progressive upload loops now logs `logger.warn` instead of swallowing silently (T002).

**Operations page broadcast metrics (T013)**
- Added a second 4-card metric row on the Operations page (Engine Uptime, Reload Reliability %, Boot Attempts, Engine Mode) that appears when `engineHealth` data is available. Cards turn red/amber on stuck/degraded conditions.

**Stream health panels (T010)**
- Source Circuit Breaker card: shows autoSuspended items + "Clear All Blocks" button.
- Media Integrity Scanner card: per-item reachability badges from `/broadcast-v2/diagnostics`.
- Dashboard (T011): red/amber banner with "Open Master Control" + "Stream Health" buttons when engine is stuck or in dead-air.

**Media scanner HEAD→GET fallback (T015)**
- `probeUrl()` in `media-integrity-scanner.ts` falls back to GET with `Range: bytes=0-1023` when HEAD returns 405. Body is immediately cancelled.
