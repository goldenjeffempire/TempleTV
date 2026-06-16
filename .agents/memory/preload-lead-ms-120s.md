---
name: BROADCAST_PRELOAD_LEAD_MS default must be 120_000 (not 90_000)
description: env.ts default was 90_000 but the orchestrator comment explicitly documents "Raised from 90 s → 120 s". Fixed to 120_000.
---

## Rule
`BROADCAST_PRELOAD_LEAD_MS` default in `artifacts/api-server/src/config/env.ts` must be `120_000`.

## Why this matters
The orchestrator uses PRELOAD_LEAD_MS to open the preload window before the current item ends. At 90s the window was 25% shorter than documented, causing:
- The `preload` frame to be sent later than intended
- Less time for the next item's URL to be validated by `scheduleProactiveProbe()`
- Higher risk of black-screen gaps on slower connections

## History
The orchestrator comment at the PRELOAD_LEAD_MS constant block explicitly says "Raised from 90 s → 120 s" but the env default was not updated in lockstep. Any future change to the documented value must update BOTH the orchestrator comment AND the env.ts default.
