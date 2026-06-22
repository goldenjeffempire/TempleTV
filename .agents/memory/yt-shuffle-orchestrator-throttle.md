---
name: yt-shuffle orchestrator-level throttle
description: Why activate() internal cooldown failed and how the orchestrator-level timestamp guard fixes it.
---

## The rule

Rate-limiting `ytShuffleFallback.activate()` must be done at the **call site in `reloadInner()`**, not inside `activate()` itself.

## Why the activate() cooldown failed

`reloadInner()` is fire-and-forget: `void ytShuffleFallback.activate(...)`. Every 5-second drift-poll calls `scheduleSelfHealReload()` → `void this.reload()` → `reloadInner()` → `void activate()`. The internal `_catalogEmptyLastCheckedMs` guard inside `activate()` appeared correct in source and compiled correctly, but in practice yt-shuffle still fired every 5 s (31×/155s). Root cause was not conclusively isolated — likely interaction between the async `_activating` guard, the fire-and-forget invocation pattern, and multiple code paths calling `activate()` simultaneously (both from `reloadInner()` fast-path AND `selfHealEmptyTimer` direct calls).

## The fix

Added `private lastYtShuffleActivateAttemptMs = 0` to `BroadcastOrchestrator` and gated the fast-path with:

```typescript
nowMs - this.lastYtShuffleActivateAttemptMs >= 60_000
```

Same pattern as the already-working `lastOffAirLogAtMs` throttle on line 1607. Reset to 0 at both queue-recovery points (selfHealEmptyTimer else-branch and `if (resolved.length > 0)` in reloadInner).

**Result**: 1 DB query per 60 s when catalog is empty (was ~12/min).

## Why

The orchestrator owns the call site and its instance fields are single-threaded / predictable. Relying on singleton state inside an async function called fire-and-forget from multiple concurrent paths is fragile.

**How to apply**: For any rate-limiting of fire-and-forget async calls from the orchestrator, use an orchestrator instance timestamp field rather than state inside the called module.
