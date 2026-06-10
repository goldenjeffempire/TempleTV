---
name: Platform audit sprint 115 — false positive patterns
description: 4 real fixes applied; key false positive patterns that recur across multi-subagent audits.
---

## Real fixes applied

1. `auto-enqueue.service.ts` — added `"upload-recovery-on-restart"` to `enqueueIfMissing` reason union (TS error from chunked-upload boot recovery path)
2. `prod-queue-sync.ts:85` — ffprobe kill-timer `setTimeout` was missing `.unref()` → held event loop open during SIGTERM drain
3. `notifications.routes.ts:17` — `void recoverStuckPendingNotifications()` in `onReady` had no `.catch()` → potential unhandled rejection on boot
4. `queue-integrity-validator.ts:165` — main active-items `db.select()` had no `.limit()` → unbounded scan on runaway queue growth; added `.limit(2000)`

## Confirmed false positive patterns (do NOT re-flag these)

**`reEnableAllSuspended` missing bus event** — every caller in orchestrator.ts and rest.routes.ts calls `reload()` immediately after; bus event inside the function would be redundant noise.

**Orphan-cleanup boot setTimeout** — already has `boot.unref?.()` at line 88; subagents sometimes miss the `.unref()` call on the next line.

**Admin SPA mutation invalidation sets** — as of this sprint all of these are complete: `faststartMutation`, `batchRetryMutation`, `bulkTranscodeMutation`, `series.tsx addEpisodeMutation/removeEpisodeMutation`, `app-versions.tsx createMutation/updateMutation/deleteMutation`. Do not re-audit these.

**`auth.routes.ts` /me + /profile missing 429 schemas** — these routes have no `config.rateLimit` so they can never return 429; 429 schema is not needed.

**`useNotificationPreferences.ts` AsyncStorage without try/catch** — all setItem/getItem calls are inside try/catch blocks; subagent hallucinated this.

**`feedback.routes.ts` missing requireAuth** — intentional design; anonymous feedback is allowed (rate-limited to 10/10min).

## Why these false positives happen

Multi-subagent audits with `run_asynchronously=true` see partial context per subagent (one module at a time). They miss: `.unref()` calls on the following line, `onSuccess` handlers already written, and intentional design choices documented in comments. Always verify by reading the actual file section before applying a fix.
