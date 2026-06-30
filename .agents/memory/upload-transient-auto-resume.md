---
name: Upload transient auto-resume
description: Why multi-GB admin uploads must auto-resume on transient errors instead of failing, and the invariants that keep that loop safe.
---

# Multi-GB upload resilience across API restarts

Multi-GB admin uploads run for many minutes. The API memory-watchdog can
restart the process mid-chunk, dropping the connection → server 499
("Client disconnected") or dev-proxy 500. Per-chunk retries (6, ~30s) are
too short to ride out a restart, so the item was marked terminally
`failed`.

**Rule:** transient worker failures (network drop, stall, timeout, 5xx,
499, retry-exhausted) must NOT mark the item `failed`. Park it as `paused`
with `wasUserPaused=false` and schedule a backoff resume that reuses the
**same sessionId** — the server-side resume check skips already-uploaded
chunks. Only `fatal` (auth) and hard 4xx are permanent.

**Why:** the resume infra already exists (same-session resume check +
IDB persistence). Routing transient failures through it makes uploads
survive any-length outage with zero re-upload of confirmed chunks.

**How to apply / invariants:**
- Reset the transient attempt counter on forward progress (confirmChunk),
  not just on completion — otherwise a long healthy upload that survives a
  few brief blips eventually exhausts the cap.
- When the backoff timer fires while `navigator.onLine === false`, defer to
  the network-online handler (add to networkPausedIds) instead of resuming
  into a guaranteed failure.
- A parked item lives in EITHER a pending timer OR networkPausedIds. A user
  Pause must handle BOTH (it has no active worker, so the normal `!ws`
  early-return path never runs) — convert to a real user pause and remove
  from networkPausedIds, or it auto-resumes on the next "online" event
  against user intent. (This exact race was the code-review blocker.)
- Clear timers + attempt counter on pause/cancel/dismiss/retry/complete so a
  cancelled/dismissed item never springs back to life.
