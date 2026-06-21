# `@workspace/broadcast-sync` — v1 broadcast sync engine

Client-side engine for consuming the v1 Temple TV real-time broadcast protocol. Powers the companion surfaces that sit alongside the v2 player — chat overlay, channel bug, on-air ticker, lower-third graphics, viewer count, prayer/reactions panel.

---

## v1 vs v2 — when to use which

| | v1 (`broadcast-sync`) | v2 (`player-core`) |
|--|----------------------|-------------------|
| **Used for** | Companion surfaces: chat, graphics, viewer count, reactions, on-air ticker | Video playback: live broadcast player on all four surfaces |
| **Transport** | SSE (`/api/broadcast/events`) with polling fallback | WebSocket-first (`/api/broadcast-v2/ws`) with SSE fallback |
| **Consumers** | TV `useLiveSync`, mobile `useBroadcastSync` | Admin v2 console, TV `LiveBroadcastV2`, mobile `V2PlayerContainer` |

Both stacks run side-by-side. Migration of companion surfaces to v2 is planned but not yet done.

---

## Usage

```tsx
import { useBroadcastSync } from "@workspace/broadcast-sync";

function ViewerCount() {
  const { viewerCount, isLive, currentItem } = useBroadcastSync({
    apiBase: "https://api.templetv.org.ng",
    channel: "temple-tv-live",
  });

  return <Text>{viewerCount} watching</Text>;
}
```

---

## Source layout

```
lib/broadcast-sync/
└── src/
    ├── index.ts               ← barrel export
    ├── engine/
    │   ├── sync-engine.ts     ← SSE connection + state machine
    │   └── poll-fallback.ts   ← HTTP polling when SSE unavailable
    └── useBroadcastSync.ts    ← React hook wrapping the engine
```

---

## SSE event types

The engine consumes named events from `/api/broadcast/events`:

| Event | Payload | Meaning |
|-------|---------|---------|
| `snapshot` | `BroadcastState` | Full current state on connect |
| `advance` | `LiveBroadcastItem` | New item started |
| `preload` | `LiveBroadcastItem` | Next item is ready (preload buffer) |
| `viewer-count` | `{ count: number }` | Viewer count tick |
| `offline` | — | Broadcast went offline |

Event shape types come from `@workspace/broadcast-types`.

---

## Fallback behaviour

When `EventSource` is unavailable (some older Smart TV browsers, React Native) or the SSE connection drops for >30 s, the engine falls back to polling `GET /api/broadcast/current` every 30 s. It automatically re-elevates to SSE when a successful connection is made.

---

## Related

- [`@workspace/broadcast-types`](../broadcast-types/README.md) — shared event/state types
- [`@workspace/player-core`](../player-core/README.md) — v2 player FSM (use for video playback)
- [`@workspace/api-server`](../../artifacts/api-server/README.md) — emits the v1 SSE events
- Project [README](../../README.md)
