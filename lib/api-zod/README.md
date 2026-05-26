# `@workspace/api-zod` — Shared Zod validation schemas

Shared Zod schemas for every Temple TV API request and response type. Generated from the live OpenAPI spec — never hand-edited.

---

## Usage

```ts
import { VideoDto, BroadcastSnapshotDto, PaginatedVideosDto } from "@workspace/api-zod";

// Parse an unknown API response
const result = VideoDto.parse(rawApiResponse);

// Use as a type
type Video = z.infer<typeof VideoDto>;
```

---

## Source structure

```
lib/api-zod/
└── src/
    ├── index.ts              ← barrel export (re-exports everything)
    └── generated/            ← AUTO-GENERATED — do not edit
        ├── videos.ts
        ├── broadcast.ts
        ├── auth.ts
        └── ...
```

Everything inside `src/generated/` is produced by `pnpm --filter @workspace/api-spec run emit` and committed alongside the API changes that triggered it.

---

## Regenerating

```bash
# Rebuild API + regenerate all generated packages
pnpm --filter @workspace/api-spec run emit
```

Verify generated files are current (CI gate):

```bash
pnpm run verify:codegen
```

---

## Important constraint

DB video columns (`description`, `thumbnailUrl`, `duration`, `category`, `preacher`, `transcodingStatus`) are nullable in PostgreSQL but Zod declares them as `z.string()`. Null values are coerced to `""` in the server's `toDto()` function. Do **not** add `.nullable()` to these schemas — it would change the public API contract and break all clients.

---

## Related

- [`@workspace/api-spec`](../api-spec/README.md) — codegen orchestrator
- [`@workspace/api-client-react`](../api-client-react/README.md) — TanStack Query hooks built on these schemas
- [`@workspace/api-server`](../../artifacts/api-server/README.md) — schema source
- Project [README](../../README.md)
