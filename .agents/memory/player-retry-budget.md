---
name: Player primary-retry budget before server-side skip
description: How many recovery attempts the client FSM makes on a stalled/errored source before it gives up and asks the server to skip the item.
---

`MAX_PRIMARY_RETRIES` in `lib/player-core/src/machine.ts` controls how many times `onBufferError()` retries the active buffer (silent primary reload → failover source or 2nd primary reload → ... → final primary reload) before transitioning to `SKIP_PENDING` and asking the server to drop the item.

Raised from 2 → 3 attempts (2026-07-06).

**Why:** raw MP4s only enter the broadcast queue once `isPlayableForBroadcast()` confirms the blob is committed (`s3MirroredAt` non-null), so a bind/stall failure on an admitted item is overwhelmingly a transient network/DB-latency hiccup, not a missing file. The operator's explicit priority is "retry, don't skip" for 24/7 broadcast — an extra automatic retry costs a few seconds of recovery buffering but converts more transient failures into full plays instead of skips.

**How to apply:** if skip complaints resurface, check this constant first before adding new recovery machinery — the escalation ladder (primary → failover → primary → skip) and the server-side stall-vote/blacklist system (`report-stall` route, `INTERNAL_UPLOAD_BAD_URL_TTL_MS=15s` for BYTEA uploads) were already extensively hardened across many prior sessions; verify with `/api/broadcast-v2/health` and DB queue state before assuming a *new* bug — this platform is frequently YouTube-only with an empty local queue (see youtube-only-broadcast.md), which is not itself a skip bug.

## Companion finding: mobile vendor player-core drift (2026-07-06)

`artifacts/mobile/vendor/player-core/src/machine.ts` is a **hand-vendored copy** of `lib/player-core/src/machine.ts` (RN/Expo can't consume the pnpm workspace package directly). It is NOT auto-synced — it had drifted significantly stale: missing the `skipPendingItemId` single-item-queue infinite-loop guard, `MAX_HANDOFF_WAIT_MS` was 3s instead of 8s (mobile gave up on a preloading buffer and froze the last frame 5s earlier than web/TV — a real source of mobile-only blank/frozen screens), and lacked the retry-budget-3 fix above. Re-synced by direct file copy (imports are identical between the two copies).

**Why:** the FSM logic (machine.ts) is pure TypeScript with no DOM/RN dependency, so it is copy-paste-safe between the two trees — but nothing enforces this, so any future fix to `lib/player-core/src/machine.ts` needs a matching copy into the mobile vendor path or mobile silently regresses behind web/TV.

**How to apply:** whenever editing `lib/player-core/src/machine.ts`, `transport.ts`, or `watchdog.ts`, immediately `diff` and re-copy the same file into `artifacts/mobile/vendor/player-core/src/`. `adapters/web.ts` is NOT shared (mobile uses its own `adapters/mobile.ts`) — do not copy that one. `types.ts` has also drifted (vendor still has the pre-removal `mp4_faststart`/`mp4_raw` sourceQuality split that the server no longer emits; mobile UI's quality badge falls back to "SD" always as a result — cosmetic only, not a playback-delay bug, left unfixed as out of scope).
