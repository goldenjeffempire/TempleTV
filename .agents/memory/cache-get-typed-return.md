---
name: In-process cache().get<T>() type must match Zod schema return
description: Using cache().get<unknown>() in a typed Fastify route handler causes TS2769 — the return type Promise<{}> is not assignable to the declared schema response.
---

## Rule
In Fastify+Zod route handlers, `cache().get<unknown>(key)` makes the handler return `Promise<{}>` (TypeScript widens `unknown` to `{}`), which fails TS2769 no-overload-match.

**Why:** Fastify's Zod type provider resolves the handler return type from the route schema's `response.200` definition. When the handler returns a value typed `unknown`, TypeScript can't confirm it matches the declared schema — it falls back to `{}` which is not a subtype of the specific response shape.

**How to apply:**  
- For routes using `ListXxxResponseSchema` / `PlaylistDetailSchema` etc., use: `cache().get<z.infer<typeof MyResponseSchema>>(key)`.  
- For ad-hoc shapes, specify the exact generic: `cache().get<{ series: Record<string, unknown>[]; total: number }>(key)`.  
- Never use `cache().get<unknown>()` in a handler that has a typed Zod response schema.
