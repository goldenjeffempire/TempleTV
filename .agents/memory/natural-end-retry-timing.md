---
name: Natural-end retry timing — broadcast pipeline
description: Tuned naturalEnd POST retry delays and machine guard timings for faster item-transition sync; vendor sync requirement.
---

## Rule

When tuning the naturalEnd / item-transition pipeline, the relevant constants are:

**`lib/player-core/src/react.ts`**
- `naturalEndRetryDelays = [300, 800, 2_000]` (was [2000, 4000, 8000])
  - Fires when the `/natural-end` POST fails (network glitch). Faster retries = shorter server-side sync gap.

**`lib/player-core/src/machine.ts`**
- TTL guard: `> 2_000` ms (was 5_000) — time before machine retries `onNaturalEndCb` when server still shows ended item
- Max retries in guard loop: `<= 5` (was 3) — more chances within the faster window
- Inner snapshot poll: `> 1_000` ms (was 3_000) — how long before re-polling `/state` inside the guard window

**`artifacts/tv/src/components/LiveBroadcastV2.tsx`**
- `STALL_REBIND_MS = 20_000` (was 30_000) — UI-level force-rebind after 20s stall

## Why

The `/natural-end` POST advances the orchestrator anchor when a video ends before its scheduled `durationSecs`. On YouTube-only deployments with 1800s placeholders, a failed POST means the server keeps showing the ended item for the full remaining slot duration. Old retries at [2s, 4s, 8s] = up to 14s of sync drift. New retries at [300ms, 800ms, 2s] = ~3s max.

## How to Apply

- **Vendor sync is mandatory**: `artifacts/mobile/vendor/player-core/` is a separate file tree (`"@workspace/player-core": "file:./vendor/player-core"` in mobile's package.json). Any change to `lib/player-core/src/machine.ts` or `lib/player-core/src/react.ts` MUST be `cp`-synced to `artifacts/mobile/vendor/player-core/src/`.
- The `/natural-end` endpoint is item-level idempotent — duplicate POSTs from overlapping retry chains are safe.
- `transport.requestSnapshot()` has an in-flight guard, so rapid `onNeedSnapshotCb()` calls don't create REST storms.
- The concurrent retry-chain risk (multiple `doPost` chains overlapping during poor connectivity) is acceptable given idempotency, but monitor `/natural-end` duplicate rate if QPS becomes a concern.
