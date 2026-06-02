---
name: Transcoder failure → broadcast-queue-updated gap
description: Permanent transcoding failure must push broadcast-queue-updated or corrupt items burn skip budget for up to 10 min before validator deactivates them.
---

## Rule
When a transcoding job permanently fails (`exceeded=true` — corrupt source, disk full, or max attempts exhausted), push `broadcast-queue-updated` immediately after `transcoding-update` so the orchestrator reloads (250 ms debounce) and the queue integrity validator runs (3 s debounce via the bus-bridge post-mutation trigger).

**Why:** The queue integrity validator's `UNPLAYABLE_CORRUPT_UPLOAD` auto-fix deactivates failed items from the broadcast queue — but it only runs on the scheduled interval (now 5 min) OR on `broadcast-queue-updated` events. Without the push, a failed/corrupt video stays in the active broadcast rotation burning skip budget on every orchestrator tick, potentially causing dead-air until the next scheduled validator run.

**How to apply:** In `transcoder.dispatcher.ts`, after the `transcoding-update` push in the error path, add a conditional `broadcast-queue-updated` push gated on `exceeded`. Include a `reason` field (`"transcoding-corrupt-source"` / `"transcoding-disk-full"` / `"transcoding-max-attempts"`) for log traceability.

## Related constants
- Queue integrity validator interval: 5 min (reduced from 10 min as belt-and-suspenders)
- Post-mutation validator trigger debounce: 3 s (in `broadcast-v2/index.ts` bus bridge)
- Orchestrator reload debounce: 250 ms (same bus bridge)
- `maxAttempts` DB default: 5 (in transcoding_jobs schema)
