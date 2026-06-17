---
name: Schedule-bridge catch-up window
description: Pattern for handling supervisor timing drift in minute-aligned schedule workers — in-memory dedup + ±2-min window.
---

# Schedule-bridge catch-up window

## The rule
Never use `startMin === currentMin` as the sole gate in a worker that fires every 60 s. Use a ±2-min trailing window (`diff >= 0 && diff <= 2`) combined with an in-memory `firedSlots` Map to prevent double-fires.

**Why:** The WorkerSupervisor fires workers sequentially. If a prior worker takes >60 s (e.g. a slow DB query), the schedule-bridge fires into the next minute and misses any entry that should have started at `currentMin - 1`. With exact matching, that entry is **permanently skipped** for that day — no catch-up ever fires.

**How to apply:**
- `firedSlots` key = `"${entryId}_${dow}_${startMin}"` — unique per scheduled slot per day.
- Mark the slot **before** calling `handleEntry` so a thrown exception doesn't cause a retry on the next tick.
- Clear `firedSlots` at midnight via a recursive `setTimeout` with `.unref()`.
- On server restart the map is empty — entries that already fired today may re-fire once, but all schedule-bridge actions are idempotent (queue unique index + override dedup key).
