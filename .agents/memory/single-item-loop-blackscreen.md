---
name: Single-item queue loop black-screen fix
description: PlayerMachine post-HANDOFF guard caused 30-90s black screen on every loop of a single-item queue; fix via lastEndedItemStartsAtMs field.
---

## Rule
`PlayerMachine` must track `lastEndedItemStartsAtMs` alongside `lastEndedItemId`. When the post-HANDOFF guard fires (same item ID is still `current`), check if `server.current.startsAtMs !== this.lastEndedItemStartsAtMs`. A mismatch means the orchestrator advanced the cycle anchor for the same item (new slot) — clear the guard **immediately** and fall through to `bindActive`.

**Why:** On a single-item queue, `lastEndedItemId` never clears because `server.current.id` never changes. The old guard blocked rebinding for the full 30 s TTL (+ up to 90 s retry), producing a black screen on every loop cycle. The orchestrator always advances `startsAtMs` when it restarts the same item, so a changed anchor is a reliable signal that the server has moved on.

**How to apply:** `lastEndedItemStartsAtMs` is set in the same two places `lastEndedItemId` is set (both HANDOFF and SYNCING paths in `onBufferEnded`), using `this.snapshot.lastServerSnapshot?.current?.startsAtMs ?? null`. It is cleared in all three places `lastEndedItemId` is cleared: the startsAtMs fast-path, the TTL-exhausted path, and the "different item arrived" path.

**Tests:** `lib/player-core/tests/single-item-loop.test.ts` — 7 tests covering the fast-path, TTL path, multi-loop stability, and multi-item guard.
