---
name: Platform audit sprint 34 — startup ordering, poller unref, register TOCTOU
description: Durable rules reinforced by a platform-wide audit; 3 real fixes, rest false positives
---

3 confirmed-real fixes; the rest of the explorer findings were false positives (see Why).

## Rules reinforced

- **A service's `ensureXxxTable()` must be `await`ed before that service starts.**
  broadcast-v2's table ensure in `main.ts` was a floating (non-awaited) `.catch()`
  call immediately followed by `await ensureBroadcastV2Started()`, which strictly
  depends on those tables — a fresh-DB race. Fixed by awaiting it (cheap CREATE IF
  NOT EXISTS, bounded by pool connectionTimeout, `.catch` keeps it non-fatal).
  **Why:** same pattern already documented for midnight-prayers table; broadcast-v2
  was inconsistent. **How to apply:** any floating table-ensure whose dependent
  service is awaited right after is a latent fresh-DB crash — await it.
  Note: `app.listen()` runs AFTER this startup block in `main.ts` (not before), so
  awaiting adds a brief bounded startup delay, not zero.

- **Background `setInterval` pollers must be `.unref?.()`-ed if their `stop()` is not
  wired into the shutdown sequence.** `youtube-live.poller.ts` had a `stop()` that
  was never called in `main.ts` shutdown and a non-unref'd timer → kept the event
  loop alive past `app.close()` until the force-exit grace timer fired. Fixed with
  `this.timer.unref?.()` after creation.

- **Select-then-insert existence checks must catch SQLSTATE `23505` and map to
  `ConflictError`.** `auth.service.ts register()` did SELECT-by-email then INSERT
  without atomicity; `users.email` is `.notNull().unique()`, so concurrent same-email
  registrations raced and the loser surfaced a raw 500. Same class as the favorites
  / analytics-viewcount TOCTOU notes. Mapping *any* 23505 on that specific insert is
  safe today (only email-unique + PK on that table).

## Why most findings were false positives
Explorer subagents over-report and **hallucinate line numbers** — every security
finding this sprint pointed at non-existent routes or misread auth guards
(admin-ops `/me`,`/sse-token`,`/live/events` all have proper auth; series
update/add-episode using `editor` is intentional content-manager RBAC, only DELETE
is admin; forgotPassword `req.log.error({err})` is intentional operator diagnostics,
no creds leaked). midnight-prayers timers are ALL already `.unref?.()`-ed. Always
verify against real code before fixing.
