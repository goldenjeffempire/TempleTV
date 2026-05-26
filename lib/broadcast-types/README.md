# `@workspace/broadcast-types` — Shared broadcast protocol types

Shared TypeScript interfaces and enums for the Temple TV real-time broadcast protocol. Consumed by the broadcast sync engine, the API server, and all client surfaces. Zero runtime dependencies — types only.

---

## Usage

```ts
import type {
  BroadcastState,
  BroadcastEvent,
  LiveBroadcastItem,
  BroadcastMode,
} from "@workspace/broadcast-types";
```

---

## What's in here

The types describe the v1 broadcast protocol — the shapes of SSE events and HTTP snapshot payloads flowing through `/api/broadcast/events` and `/api/broadcast/current`. These are used by:

- `@workspace/broadcast-sync` — the client-side sync engine
- `@workspace/api-server` — the broadcast engine emitting these shapes
- `artifacts/tv` — `useLiveSync` hook consuming them
- `artifacts/mobile` — `useBroadcastSync` hook consuming them

**v2 broadcast types** (for the `PlayerMachine` A/B-buffer FSM) live in `@workspace/player-core/src/types.ts` — not here. The v1 types here back companion surfaces: chat overlay, channel bug, on-air ticker, lower-third graphics, viewer count, prayer/reactions panel.

---

## Source

```
lib/broadcast-types/
└── src/
    └── index.ts    ← all type exports
```

---

## Related

- [`@workspace/broadcast-sync`](../broadcast-sync/README.md) — v1 sync engine consuming these types
- [`@workspace/player-core`](../player-core/README.md) — v2 player types and FSM
- [`@workspace/api-server`](../../artifacts/api-server/README.md) — emits these shapes
- Project [README](../../README.md)
