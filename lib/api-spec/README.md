# `@workspace/api-spec` — OpenAPI spec + codegen orchestrator

Orchestrates OpenAPI spec generation and client codegen for the Temple TV API. The spec is the authoritative contract between the server and all generated client packages.

---

## How it works

The spec is **not a static file** — it is generated at runtime from the live Fastify application. The `@fastify/swagger` plugin introspects all Zod-typed routes registered in `@workspace/api-server` and emits a fully-resolved OpenAPI 3.1 document.

```
@workspace/api-server (Zod schemas → fastify-type-provider-zod)
        │
        ▼
GET /docs/json  OR  pnpm --filter @workspace/api-server run openapi
        │
        ▼
lib/api-spec/openapi.json   (committed, source of truth)
        │
        ├──► lib/api-zod/src/generated/    (Zod schemas)
        └──► lib/api-client-react/src/generated/  (TanStack Query hooks)
```

---

## Commands

```bash
# Generate the spec from the running API and regenerate all clients
pnpm --filter @workspace/api-spec run emit

# Verify generated files are up to date (CI gate)
pnpm run verify:codegen
```

`verify:codegen` runs `emit` and checks `git diff` on the generated directories. It fails if the committed files are out of sync with the current server schema — ensuring every schema change ships with updated clients.

---

## Workflow when changing the API schema

1. Edit Zod schemas in `@workspace/api-server`
2. Build the API: `pnpm --filter @workspace/api-server run build`
3. Regenerate clients: `pnpm --filter @workspace/api-spec run emit`
4. Review the diff in `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/`
5. Commit both the schema change and the generated files together
6. CI runs `verify:codegen` — fails if committed files diverge from the spec

**Never hand-edit files in `lib/api-zod/src/generated/` or `lib/api-client-react/src/generated/` — they will be overwritten.**

---

## Related

- [`@workspace/api-server`](../../artifacts/api-server/README.md) — spec source
- [`@workspace/api-zod`](../api-zod/README.md) — generated Zod schemas
- [`@workspace/api-client-react`](../api-client-react/README.md) — generated hooks
- Project [README](../../README.md)
