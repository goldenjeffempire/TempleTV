---
name: YouTube-only broadcast alert suppression
description: When ALL library videos are YouTube-sourced, queue-exhaustion/auto-refill/health-guard alerts must be suppressed — ytShuffleFallback provides broadcast continuity automatically.
---

## The problem

A YouTube-only deployment (all managed_videos have video_source='youtube') produces a permanently empty local broadcast_queue because:
- auto-queue-refill excludes YouTube videos (they must not be inserted directly into broadcast_queue)
- queue-health-guard reconciliation finds nothing eligible
- queue-exhaustion-monitor sees 0 items → fires CRITICAL every 10 min

All three components were firing ops-alerts (CRITICAL/WARN) every cycle despite the broadcast being ON AIR via the YouTube shuffle fallback or a manual override.

## The fix (implemented)

### 1. Orchestrator — `getOverrideState()` method added
```typescript
broadcastOrchestrator.getOverrideState(): { kind, title, endsAtMs, isYtShuffle } | null
```
Returns null when no override is active. All monitoring consumers call this before emitting alerts.

### 2. Queue exhaustion monitor
- Deferred initial check by 90 s (boot-time grace: ytShuffleFallback needs ~30 s to activate)
- Before alerting: lazily imports orchestrator + ytShuffleFallback singleton
- If `override !== null` OR `ytShuffleFallback.isActive` → downgrade CRITICAL/WARN to INFO
- `ExhaustionStatus` exposes `overrideSuppressed`, `overrideKind`, `overrideTitle`

### 3. Auto-queue-refill
- When no candidates found: queries YouTube vs local video counts
- If `localCount === 0 && youtubeCount > 0` → logs INFO (not WARN), no ops-alert
- Also checks override state before firing the "no-candidates" ops-alert

### 4. Queue health guard
- Before firing "below threshold" ops-alert: lazily imports orchestrator
- If override active → logs INFO, does NOT push ops-alert

### 5. Startup verification (main.ts 30s post-boot check)
- Added library composition query (YouTube vs local count)
- Logs `library.isYouTubeOnly: true` at INFO when all videos are YouTube

**Why:**
- YouTube-only deployments are valid production configurations (church uses YouTube + shuffle fallback)
- All three monitors fired false-positive alerts every cycle → alert fatigue
- ytShuffleFallback activates ~30 s after boot when queue is empty; the 90 s delay ensures first exhaustion check sees it active

**How to apply:**
- Any new monitoring code that checks queue size must also check `broadcastOrchestrator.getOverrideState()` before emitting WARN/CRITICAL ops-alerts
- `ytShuffleFallback.isActive` is the supplementary signal for YouTube-shuffle-specific suppression
- `getOverrideState()` is exported via the `index.ts` re-export of `broadcastOrchestrator`
