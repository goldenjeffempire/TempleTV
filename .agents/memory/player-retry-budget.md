---
name: Player primary-retry budget before server-side skip
description: How many recovery attempts the client FSM makes on a stalled/errored source before it gives up and asks the server to skip the item.
---

`MAX_PRIMARY_RETRIES` in `lib/player-core/src/machine.ts` controls how many times `onBufferError()` retries the active buffer (silent primary reload → failover source or 2nd primary reload → ... → final primary reload) before transitioning to `SKIP_PENDING` and asking the server to drop the item.

Raised from 2 → 3 attempts (2026-07-06).

**Why:** raw MP4s only enter the broadcast queue once `isPlayableForBroadcast()` confirms the blob is committed (`s3MirroredAt` non-null), so a bind/stall failure on an admitted item is overwhelmingly a transient network/DB-latency hiccup, not a missing file. The operator's explicit priority is "retry, don't skip" for 24/7 broadcast — an extra automatic retry costs a few seconds of recovery buffering but converts more transient failures into full plays instead of skips.

**How to apply:** if skip complaints resurface, check this constant first before adding new recovery machinery — the escalation ladder (primary → failover → primary → skip) and the server-side stall-vote/blacklist system (`report-stall` route, `INTERNAL_UPLOAD_BAD_URL_TTL_MS=15s` for BYTEA uploads) were already extensively hardened across many prior sessions; verify with `/api/broadcast-v2/health` and DB queue state before assuming a *new* bug — this platform is frequently YouTube-only with an empty local queue (see youtube-only-broadcast.md), which is not itself a skip bug.
