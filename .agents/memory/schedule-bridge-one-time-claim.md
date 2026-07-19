---
name: Schedule bridge — one-time entry exactly-once execution
description: One-time schedule entries must be claim-deactivated BEFORE the broadcast action fires, not after.
---

## The rule

`schedule-bridge.ts` must use `scheduleService.claimOneTimeFiring(id)` (atomic UPDATE WHERE is_active=true RETURNING) **before** calling `handleEntry()` for any entry with `scheduledDate IS NOT NULL`.

**Why:** The original pattern called `deactivateOneTime()` *after* `handleEntry()`. If the process crashed after the action fired but before the DB write, `firedSlots` was empty after restart and the entry would re-fire on the next scan. Double-fire means duplicate live overrides / duplicate enqueues.

**How to apply:** The claim is in `scheduleService.claimOneTimeFiring(id)` — returns `true` if this process won the atomic claim, `false` if already claimed. Only call `handleEntry()` when it returns `true`. If the claim DB write fails, skip with a warn log (better to miss one fire than to risk a double).

For **recurring** entries (no `scheduledDate`), the in-memory `firedSlots` map is the correct dedup mechanism — no DB claim needed.

## Added method

`scheduleService.claimOneTimeFiring(id: string): Promise<boolean>` in `schedule.service.ts`.
