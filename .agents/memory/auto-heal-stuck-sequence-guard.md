---
name: Auto-heal stuck-sequence withinPlaybackWindow guard
description: Auto-heal monitor must not fire "stuck sequence" during normal long-video playback — needs the same withinPlaybackWindow check used in the health endpoint.
---

# Auto-heal stuck-sequence withinPlaybackWindow guard

## The rule
`auto-heal-monitor.ts` stuck-sequence detection must include a `withinPlaybackWindow` guard before calling `orchestrator.reload()` or raising the BROADCAST_STUCK alert.

```typescript
const currentItemElapsedMs = snap?.current != null ? now - snap.current.startsAtMs : 0;
const currentItemDurationMs = snap?.current != null ? snap.current.durationSecs * 1_000 : 0;
const withinPlaybackWindow =
  snap?.current != null &&
  currentItemElapsedMs < currentItemDurationMs + SEQUENCE_STALE_GRACE_MS; // 2 min
const genuinelyStuck =
  started && itemCount > 0 && advanceAgeMs > STUCK_THRESHOLD_MS && !withinPlaybackWindow;
```

**Why:** `STUCK_THRESHOLD_MS = 90s`. Any video longer than 90s causes false-positive stuck alerts and unnecessary `orchestrator.reload()` calls every 120s (the BROADCAST_STUCK cooldown). A 22-minute sermon would trigger ~10 spurious reloads per video.

**How to apply:** Use the `genuinelyStuck` boolean instead of the inline condition. The `else` branch should use `!genuinelyStuck` to clear the alert — if withinPlaybackWindow, we are NOT stuck and the alert should be cleared. Only fire when elapsed > durationSecs × 1000 + 2-min grace, meaning item.advanced genuinely never fired.
