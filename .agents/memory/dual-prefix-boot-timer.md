---
name: Dual-prefix boot-timer double-fire
description: registerDomainRoutes is registered at both /api/v1 and /api in app.ts — any Fastify plugin body with a boot-time setTimeout runs twice, creating duplicate timers.
---

## The rule
Any code that runs inside a Fastify plugin's body function (not inside a route handler) and has side effects (setInterval, setTimeout, singleton mutations) will execute **twice** because `registerDomainRoutes` is registered at both `/api/v1` and `/api` in `app.ts`:

```js
await app.register(registerDomainRoutes, { prefix: API_PREFIX }); // /api/v1
await app.register(registerDomainRoutes, { prefix: "/api" });     // /api
```

## Observed failure
`autoEnqueueMissingHls()` boot timer in `rest.routes.ts` fired at T+15 s and again at T+15.3 s on every restart. The `_hlsScanInFlight` in-flight guard only blocked *concurrent* calls — the second timer fired after the first had already completed, causing a redundant DB scan and orchestrator reload.

**Why:** Fastify calls the plugin function once per `register()` call. Two `register()` calls → two plugin invocations → two `setTimeout(…, 15_000)` timers created.

## Fix pattern
Add a **module-level boolean flag** (not scoped inside the plugin function) that is set on first timer creation and checked on subsequent invocations:

```ts
// module-scoped — survives both plugin instantiations
let _bootScanScheduled = false;

// inside the plugin function body:
if (!_bootScanScheduled) {
  _bootScanScheduled = true;
  const t = setTimeout(() => { doBootWork(); }, 15_000);
  t.unref?.();
}
```

## How to apply
- Check every `async function myPlugin(app: FastifyInstance)` that is transitively registered inside `registerDomainRoutes` for top-level `setTimeout` / `setInterval` calls.
- Any such timer must be guarded by a module-level flag (`let _xxxScheduled = false`).
- The `_idempotencyGcTimer` and `_stallVotesGcTimer` intervals in `rest.routes.ts` are intentionally harmless duplicates (GC fires twice — safe) and were left as-is for minimal diff; if they become a concern they follow the same flag pattern.
