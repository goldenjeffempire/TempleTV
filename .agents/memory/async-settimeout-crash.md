---
name: Async-setTimeout crash pattern
description: setTimeout(async) without try/catch crashes Node ≥15 via unhandledRejection — fix pattern and audit notes.
---

## Rule
Any `setTimeout(async () => { await ... })` callback that lacks a `try/catch` will throw an **unhandled promise rejection** if the awaited operation fails. In Node ≥15 this terminates the process.

## Fix pattern
```typescript
const t = setTimeout(() => {
  void (async () => {
    try {
      await db.update(...);
      // emit events etc.
    } catch (err) {
      logger.warn({ err, id }, "[module] timer callback failed (non-fatal)");
    }
  })();
}, delayMs);
t.unref?.(); // don't block process exit
```

**Why:** The outer arrow is sync (returns a Promise silently dropped by `void`). The inner IIFE owns the rejection; `try/catch` converts it to a warn log instead of a process crash.

**How to apply:** Any time a new timed auto-dismiss, auto-deactivate, or debounce callback uses `async` — always wrap with this pattern.

## Known fixed locations (as of sprint 36)
- `artifacts/api-server/src/modules/graphics/graphics.routes.ts` — graphic auto-dismiss
- `artifacts/api-server/src/modules/emergency/emergency.routes.ts` — alert auto-dismiss

## Confirmed safe (already correct)
- `artifacts/api-server/src/modules/youtube-webhook/youtube-webhook.routes.ts` — has its own try/catch/finally inside the async setTimeout
