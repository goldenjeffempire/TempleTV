---
name: Broadcast v2 emergency filler hardening
description: 6 bugs fixed in emergency-filler + YouTube probe logic; new large-queue activation path via allBlockedRecoveryCycles.
---

## Bugs fixed

### 1. Filler never activates for queues with > 5 items
`autoSkipAttempts < 5` cap stops the skip loop before `consecutiveSkips >= items.length` can ever fire for large queues. Fix: added `allBlockedRecoveryCycles` counter. Each TTL-recovery cycle (90 s) without any item playing increments it. After ≥ 2 cycles (≥ 3 min), filler is inserted via the TTL-recovery branch regardless of queue size.

**Why:** The small-queue path (consecutiveSkips >= items.length inside the autoSkipAttempts < 5 block) only works for queues of ≤ 5 items. Large queues had no filler activation path for permanent CDN failures.

**How to apply:** Any change to the all-blocked-TTL recovery branch must also account for this counter (reset it when any item plays, don't reset it in the TTL branch itself until the filler fires).

### 2. Filler HLS detection fragile
`fillerUrl.includes(".m3u8")` breaks for signed/CDN URLs with query params or fragments (e.g. `stream.m3u8?token=abc`). Fixed with `/\.m3u8(?:$|\?|#)/i.test(fillerUrl)` in all three filler insertion paths.

### 3. `skip()` filler path missing `clearBadUrl()` call
The operator-skip filler path didn't call `clearBadUrl(fillerUrl)` before inserting the filler. If a prior CDN outage had marked the filler URL bad, the filler would immediately project as null → trigger another skip → infinite spiral. Fixed: added `clearBadUrl(fillerUrl)` in the `skip()` path (tickInner path already had it).

### 4. Filler duration hardcoded at 300s
Too short for live HLS filler streams (players stall after 5 min). Changed to 3600 s (1 hour) in all three insertion paths. The filler is removed on the next reload when operators fix sources.

### 5. YouTube probe misses 404/410
`probeYouTubeReachability()` only treated HTTP 403 and 451 as "blocked". Private/deleted YouTube videos return 404; permanently removed videos return 410. Fixed: expanded to treat 403, 404, 410, 451 all as "blocked".

### 6. `allBlockedRecoveryCycles` reset placement
Must reset to 0 in the `tickInner()` branch where `snap.current !== null` (playable item found) AND in `naturalItemEnd()` is implicitly covered because consecutive skips reset there. The new counter is separate from `consecutiveSkips`.

## Key constants
- `BAD_URL_TTL_MS` = 90 000 ms (90 s per TTL cycle)
- `allBlockedRecoveryCycles >= 2` → filler activates (≥ 3 min of persistent blocking)
- `autoSkipAttempts < 5` → cap on rapid skips (protects against storm)
- Filler duration: 3600 s
