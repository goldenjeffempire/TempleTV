# `@workspace/api-client-react` — TanStack Query hooks for the Temple TV API

Generated TanStack Query v5 hooks for every Temple TV API endpoint. Consumed by the admin dashboard, TV app, and mobile app — never fetch the API directly from a component; use these hooks instead.

---

## Usage

```tsx
import {
  useListAdminVideos,
  useGetBroadcastSnapshot,
  useListPlaylists,
} from "@workspace/api-client-react";

function VideoList() {
  const { data, isLoading } = useListAdminVideos({ limit: 20 });
  // data is fully typed via @workspace/api-zod
}
```

---

## Source structure

```
lib/api-client-react/
└── src/
    ├── index.ts              ← barrel export
    ├── client.ts             ← shared fetch wrapper (base URL, auth headers)
    └── generated/            ← AUTO-GENERATED — do not edit
        ├── videos.ts
        ├── broadcast.ts
        ├── auth.ts
        └── ...
```

Everything inside `src/generated/` is produced by `pnpm --filter @workspace/api-spec run emit`.

---

## Peer dependencies

```json
{
  "@tanstack/react-query": "^5.0.0",
  "react": ">=18"
}
```

A `QueryClient` must be provided higher in the component tree:

```tsx
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
const queryClient = new QueryClient();

<QueryClientProvider client={queryClient}>
  <App />
</QueryClientProvider>
```

---

## Global query defaults (admin)

The admin dashboard applies these defaults to its `QueryClient`:

```ts
defaultOptions: {
  queries: {
    staleTime: 60_000,       // 1 min
    gcTime: 10 * 60_000,     // 10 min
    placeholderData: prev,   // keep previous data while refetching
  }
}
```

Plus a 3-tier background prefetch chain at 2 / 5 / 10 s on first load via `requestIdleCallback`.

---

## Key hooks (examples)

| Hook | Endpoint | Notes |
|------|----------|-------|
| `useListAdminVideos` | `GET /api/v1/admin/videos` | `limit=20` param (not `pageSize`) |
| `useGetBroadcastSnapshot` | `GET /api/broadcast-v2/snapshot` | v2 orchestrator current state |
| `useListPlaylists` | `GET /api/v1/playlists` | |
| `useGetSchedule` | `GET /api/v1/schedule` | |
| `useGetAnalytics` | `GET /api/v1/analytics/*` | |

---

## Regenerating

```bash
pnpm --filter @workspace/api-spec run emit
```

---

## Related

- [`@workspace/api-spec`](../api-spec/README.md) — codegen orchestrator
- [`@workspace/api-zod`](../api-zod/README.md) — Zod schemas these hooks are typed against
- [`@workspace/api-server`](../../artifacts/api-server/README.md) — API source
- Project [README](../../README.md)
