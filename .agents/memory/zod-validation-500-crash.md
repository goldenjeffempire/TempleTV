---
name: Request validation failures surfaced as 500 (not 400)
description: Why a bad querystring/param/body returned "Internal server error" instead of a clean 400, and the fix.
---

# Validation-phase errors must map to 400, never 500

`fastify-type-provider-zod@4`'s `createValidationError` does
`error.errors.map(...)`. For some zod error shapes `error.errors` is
`undefined`, so it throws a raw `TypeError: Cannot read properties of undefined
(reading 'map')` **during** Fastify's validation phase. Fastify tags that
TypeError with `code: "FST_ERR_VALIDATION"` + `validationContext` and hands it to
the app error handler — but it is **not** a `ZodError` instance, so an
`err instanceof ZodError` check misses it and it falls through to the generic 500
branch. Operators then see a bogus "Internal server error" toast for what is
really bad client input.

**Rule:** the error handler must treat *any* validation-phase error as 400.
Detect it by `err.validationContext` (Fastify sets this for body/query/params/
headers validation) OR `err.code === "FST_ERR_VALIDATION"` — do NOT rely on
`instanceof ZodError` alone. This is robust even when the underlying formatter
crashes.

**Also:** don't put `z.string().min(1)` (or other reject-empty rules) on a
querystring that has a legitimate empty case (e.g. a batch endpoint asked about 0
ids). Empty then *fails validation* and trips the crash above. Prefer
`z.string().optional()` and handle empty in the handler (return the empty result)
— a 0-item batch query should be a 200 with an empty payload, not a 4xx/5xx.

**Why:** several admin polling endpoints (e.g. broadcast-v2 `queue-status`) fired
with empty params during initial render / restart windows and produced recurring
500 toasts even though the broadcast itself was healthy.
