---
name: Notification dispatcher atomic claim pattern
description: How to safely claim rows for a poll-based worker queue with FOR UPDATE SKIP LOCKED, and why attempts/sentCount must be separate counters.
---

## FOR UPDATE SKIP LOCKED claim must be in the same transaction as the follow-up UPDATE

A `SELECT ... FOR UPDATE SKIP LOCKED` only holds its row locks for the lifetime of the transaction it runs in. If the `SELECT` and the subsequent `UPDATE ... SET status='sending' WHERE id IN (...)` run as two separate statements/transactions, the lock is released before the UPDATE executes — a second concurrent poller can select and claim the *same* rows in the gap, causing duplicate sends.

**Why:** this is a subtle self-review catch — the code can look correct (uses SKIP LOCKED, uses a transaction wrapper) while the actual claim SELECT and the status-flip UPDATE are accidentally issued outside of one `db.transaction(...)` callback.

**How to apply:** for any poll-based claim-and-process worker, wrap the claim SELECT and the immediate status-flip UPDATE in a single `db.transaction()` call. Verify by reading the diff for the transaction boundary, not just for the presence of `FOR UPDATE SKIP LOCKED`.

## Decouple retry-attempt counter from delivery-success counter

Don't reuse a "sentCount" (successful deliveries, e.g. push recipients reached) as the retry/backoff counter. They answer different questions: sentCount is a business metric (how many devices got the notification), attempts is an operational counter (how many times the dispatcher tried to process this row, used for exponential backoff and dead-lettering).

**Why:** conflating them either under-counts retries (a partial delivery success resets backoff) or produces misleading delivery metrics (a retried-but-undelivered row inflates sentCount).

**How to apply:** add a dedicated `attempts` column purely for backoff/dead-letter thresholds; keep the delivery-count column purely as a reporting metric of successful sends.

## Stuck-row recovery must key off claim time, not schedule time

A "reset stuck sending rows" sweep must compare against `claimedAt` (when this attempt started), not `scheduledAt` (when the row became eligible). Keying off `scheduledAt` will immediately re-claim rows that are correctly `sending` and mid-flight the moment their original scheduled time is more than the stuck-threshold in the past — a near-certainty for any row that was ever delayed.
