---
name: registerDomainRoutes prefix doubling
description: Public routes inside registerDomainRoutes already inherit /api; adding { prefix: "/api" } doubles the path.
---

## Rule

`registerDomainRoutes` in `artifacts/api-server/src/app.ts` is registered **twice** — at `{ prefix: "/api" }` and `{ prefix: "/api/v1" }` — via `app.register(registerDomainRoutes, { prefix: "/api" })`.

Any route registered inside it with `{ prefix: "/api" }` will resolve to `/api/api/<path>`.

**Correct pattern for a public endpoint at `/api/feedback`:**
```ts
// Inside registerDomainRoutes:
await instance.register(feedbackRoutes);          // no extra prefix
// route handler: r.post("/feedback", …)
// → resolves to /api/feedback ✓
```

**Wrong:**
```ts
await instance.register(feedbackRoutes, { prefix: "/api" });
// → resolves to /api/api/feedback ✗
```

**Why:** The function is a Fastify plugin; prefixes compose multiplicatively.

**How to apply:** Whenever adding a new public module to `registerDomainRoutes`, choose the sub-prefix relative to `/api`. Sub-paths like `/broadcast` or `/auth` are fine. Never add `/api` as an inner prefix there.
