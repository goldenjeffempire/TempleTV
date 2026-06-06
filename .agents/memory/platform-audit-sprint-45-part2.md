---
name: Comprehensive platform audit sprint 45 part 2
description: 9 bugs fixed across admin UI, API schemas, DB indexes, and notifications service.
---

## Bugs Fixed

### 1. users.tsx — Ban chat fired without AlertDialog
- Line 245: `onClick={() => banChatMutation.mutate(user.id)}` fired immediately
- Fix: Added `banningUser` state, changed to `setBanningUser(user)`, added full AlertDialog with amber confirm button
- Pattern: all destructive DropdownMenuItem actions must open an AlertDialog, not call the mutation directly

### 2. password_reset_tokens schema — missing userId index
- `lib/db/src/schema/password-reset-tokens.ts` had userId FK but no index
- Fix: Added `(table) => ({ userIdIdx: index("idx_password_reset_tokens_user_id").on(table.userId) })`
- `pnpm --filter @workspace/db run push` applied the change (no data change needed)

### 3. analytics.tsx — concData/platData charts showed blank on query failure
- Concurrent viewers + device sessions charts had no `isError` branch; showed empty state instead of error on API failure
- Fix: added `isError: concError` / `isError: platError` to useQuery, added retry button panels inside ChartErrorBoundary

### 4. operations.tsx — systemMetrics query swallowed errors with .catch(() => null)
- ErrorAlert at line 355+ existed but never fired because queryFn resolved null on error
- Fix: removed `.catch(() => null)` from systemMetrics queryFn only; kept it on engineHealth and emergencyAlerts (intentional graceful-degrade)

**Why:** engineHealth/emergencyAlerts are best-effort dashboard widgets; systemMetrics IS the dashboard data — error must surface.

### 5. playlists.schemas.ts — ReorderBodySchema videoIds array unbounded
- `z.array(z.string().min(1)).min(1)` with no `.max()` — editor-role DoS vector
- Fix: added `.max(500)` cap

### 6. admin-broadcast.routes.ts — ReorderBodySchema itemIds array unbounded
- Same DoS vector for broadcast queue reorder
- Fix: added `.max(500)` cap

### 7. broadcast-v2.tsx — engine health card showed "Loading…" on persistent error
- `!engineHealth` check rendered "Loading…" even when `engineHealthError` was true
- `engineHealthError` was already destructured from useQuery at line 865
- Fix: added `engineHealthError ? "Could not load engine health — retrying…" :` before the null check

### 8–9. notifications — stuck-pending immediate push notifications
- `sent_notifications` rows inserted as `status='pending'` had no recovery sweep (unlike `scheduled_notifications` which has resetStuckSending)
- If process crashed between DB insert and deliverPushNotification completion, row stayed permanently pending
- Fix: added `recoverStuckPendingNotifications()` in notifications.service.ts (marks rows with status='pending' older than 30 min as 'failed')
- Wired up via `app.addHook("onReady", ...)` in notifications.routes.ts

## False Positives (documented to avoid re-audit)

- TV app: PiP `.catch()` already present; override kind listener correctly cleaned up; sendReaction has try/catch; serverSync has AbortSignal.timeout + .catch()
- Mobile: library.tsx and search.tsx FlatLists already have keyExtractor
- API auth: all write routes correctly use requireAuth; channel admin/editor split is intentional design
- Player-core transport jitter timer: connectWs() has `this.stopped` guard, so post-stop fire is harmless
- Notifications idempotency skip on partial failure: known limitation, documented; retry with same key correctly returns existing row
- Broadcast leader "zombie" on Redis down: intentional availability-over-consistency design
- Broadcast queue DnD race: two admins simultaneously reordering is handled by SSE invalidation on both sides (window is tiny)
