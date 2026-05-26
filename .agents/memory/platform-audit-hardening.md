---
name: Platform audit hardening batch
description: Six production-risk fixes applied after full-platform audit (upload, transcoding, HLS, broadcast, mobile, workers).
---

## Fixes applied (May 2026)

### 1. Mobile AsyncStorage crash guard (useFavorites / useWatchHistory)
**Rule:** Always wrap `JSON.parse(AsyncStorage raw)` in try/catch, delete the key on corruption.
**Why:** Corrupted or truncated AsyncStorage values cause unhandled JSON.parse exceptions that crash the React Native bridge on every app launch until the user reinstalls.
**How to apply:** Any new hook reading from AsyncStorage must follow this pattern — read raw, try-parse, on catch removeItem + fall back to empty state.

### 2. Media integrity scanner batch isolation
**Rule:** Wrap `probeHlsManifest` / `probeUrl` in a per-item try/catch inside the `Promise.all` batch.
**Why:** Both probe functions are designed non-throwing, but an unexpected exception in one item's async mapper propagates to `Promise.all` and aborts every item in the current batch — corrupting failure-count state for all items.
**How to apply:** Any `Promise.all` batch that calls async probes/fetches must add a `.catch` or try/catch on each item, treating the exception as `ok: false` with a logged `failReason`.

### 3. Orphan cleanup — batched DELETEs
**Rule:** Use `DELETE … WHERE id IN (SELECT id … LIMIT 5000)` instead of unbounded DELETE.
**Why:** On a multi-year prod DB a single sweep deleting 100k+ rows holds a row-level lock for seconds, blocking concurrent notification reads/writes for all users mid-broadcast.
**How to apply:** All retention-sweep DELETEs that could accumulate >10k rows must be batched; leftover rows are handled on the next scheduled sweep.

### 4. HLS_TOKEN_SECRET startup warning
**Rule:** Log a production `WARN` at boot when `HLS_TOKEN_SECRET` is unset.
**Why:** The fallback `"temple-tv-hls-default"` is a known constant — anyone can construct a valid signed token for any videoId, bypassing token-gated HLS playback entirely.
**How to apply:** The warning is in `videoServeRoutes()`. It fires only in `production` so dev is not noisy.

### 5. Notification dispatcher stuck-"sending" recovery
**Rule:** On `dispatcher.start()`, reset rows in `status='sending'` older than 5 min back to `status='pending'`.
**Why:** If the Node process is killed (SIGKILL, OOM) between the `UPDATE…SET status='sending' RETURNING` claim and the subsequent `UPDATE…SET status='sent'`, rows are permanently stuck — they are never re-dispatched and never appear as failures.
**Why safe:** The `idempotencyKey: \`scheduled:${row.id}\`` on the audit row means a re-dispatched push is a no-op even if the first attempt actually reached the push provider before the crash.
**How to apply:** The `resetStuckSending()` private method in `ScheduledNotificationDispatcher` handles this. Any new dispatcher class with claim-then-update semantics should follow the same pattern.

## Confirmed non-issues (from audit, validated by code review)
- **SSRF suffix matching (`endsWith`)** — `endsWith(".templetv.org.ng")` correctly requires a literal dot before the domain; `"eviltempletv.org.ng"` does NOT match because its last 16 chars are `"ltempletv.org.ng"`, not `".templetv.org.ng"`. The explore agent was incorrect.
- **`probeHasAudio` false-on-timeout** — intentional design; video-only output is safe, but a `v:i,a:i` var_stream_map against a no-audio input kills ffmpeg with exit 234.
- **Stall vote double-skip** — already protected by `stallActionCooldown` map added in a prior session.
- **Notification double-send** — already protected by unique partial index on `idempotency_key` in `sent_notifications`.
