---
name: broadcast-v2 admin page — false indicators with override active
description: 5 bugs that fire false-positive Off-Air warnings on the Master Control page when ytShuffleFallback/override is active with an empty local queue.
---

## Rule
When `engineHealth.hasOverride === true` (override or ytShuffleFallback active), the local queue is intentionally empty — the broadcast IS on air. All health checks that key off `itemCount === 0`, `hasCurrent === false`, `queueItems.length === 0`, or `sequence === 0` must account for this.

**Why:** `snap.current` is null in override mode (server design: override replaces queue items). So `hasCurrent = false` and `sequence` may stay 0. This caused 5 false indicators to fire simultaneously.

## The 5 fixes (all in broadcast-v2.tsx or BroadcastUploadPanel.tsx)

1. **BroadcastUploadPanel.tsx** line ~404: `["broadcast-v2-state"]` → `["broadcast-v2-live-state"]` — wrong query key meant live state never refreshed after queuing a video from the upload panel.

2. **Off-Air card #1** ("Orchestrator loaded 0 items"): add `&& !engineHealth.hasOverride` to condition. Guard: `engineHealth.itemCount === 0 && !engineHealth.hasCurrent && !engineHealth.hasOverride`.

3. **Off-Air card #2** (queue-empty): add `&& engineHealth?.mode !== "override"` to the `!queueLoading && queueItems.length === 0` condition.

4. **Checklist "Queue populated"**: `pass: activeQueueCount > 0 || engineHealth.hasOverride`; set `warn` (not fail) when override active with empty queue.

5. **Checklist "Engine running"**: `pass: boot.started && (sequence > 0 || uptimeMs < 30_000 || engineHealth.hasOverride)`.

## How to apply
Whenever you add new health checks or Off-Air cards that key off queue emptiness or sequence=0, always add `|| engineHealth.hasOverride` (or equivalent) to avoid false positives in YouTube-only / override-driven deployments.
