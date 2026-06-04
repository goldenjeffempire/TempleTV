---
name: Fastify schema 429 responses
description: Any route that calls reply.code(429).send({error}) must declare 429 in the Fastify response schema or tsc fails.
---

## Rule
When a Fastify route returns `reply.code(429).send({ error: "..." })`, the route's `schema.response` object **must** include:

```typescript
429: z.object({ error: z.string() }),
```

**Why:** fastify-type-provider-zod uses the response schema to infer the TypeScript return type. If 429 is absent, tsc reports TS2345 ("Argument of type '429' is not assignable to parameter of type '201'") and TS2353 ("Object literal may only specify known properties, and 'error' does not exist in type …").

**How to apply:** Add to the `response` block of any route that sends a 429 (rate limit, row-count cap, etc.). Pattern is consistent across all status codes — missing any code in the response schema that the handler sends will produce the same tsc errors.
