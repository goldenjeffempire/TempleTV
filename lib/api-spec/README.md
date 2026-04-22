# `@workspace/api-spec` — OpenAPI source-of-truth

Owns the **single OpenAPI 3.1 document** that describes the Temple TV API.
This document is the source from which Zod schemas (`@workspace/api-zod`) and
React Query hooks (`@workspace/api-client-react`) are generated.

> If you change an endpoint, change it here **first**, then run codegen.

---

## 1. Files

```
lib/api-spec/
├── package.json
├── orval.config.ts        ← code generator configuration
├── openapi.yaml           ← the spec (source of truth)
└── README.md
```

---

## 2. Regenerating downstream packages

```bash
pnpm --filter @workspace/api-spec run codegen
```

This runs Orval and refreshes:

- `lib/api-zod/src/generated/**` — Zod schemas + TS types
- `lib/api-client-react/src/generated/**` — React Query hooks + fetcher

The generated files **must not** be hand-edited; downstream changes to the
API surface always start with editing `openapi.yaml` and re-running codegen.

---

## 3. Conventions

- Use **operationId** in `camelCase` — Orval turns it into the hook name
  (`useGetLiveStatus`, `useListAdminVideos`, ...).
- Group endpoints with `tags` — these become section headers in any rendered
  documentation.
- Always declare **request body schemas** under `components.schemas` so they
  are exported as standalone Zod objects (instead of inlined per-route).
- Use `securitySchemes.bearerAuth` for any admin route.

---

## 4. Related

- [`@workspace/api-server`](../../artifacts/api-server/README.md) — implements
  the spec.
- [`@workspace/api-zod`](../api-zod/README.md) — generated request/response
  schemas, used server-side for validation and client-side for safe parsing.
- [`@workspace/api-client-react`](../api-client-react/README.md) — generated
  React Query hooks, consumed by the admin and TV apps.
- Project [README](../../README.md)
