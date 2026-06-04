---
name: WS concurrent-resume phantom-listener fix
description: Two rapid `resume` messages from the same WS client caused double onFrame registration, delivering every subsequent broadcast frame twice.
---

## Rule
After the DB replay `await` in the WS `resume` handler, check `if (activeFrameHandler !== bufferFrame) return` **before** calling `off(bufferFrame)` + `on(onFrame)`.

**Why:** `bufferFrame` is closure-local to each `resume` message handler. If a second `resume` arrives while the first is awaiting the DB replay, the second handler:
1. Removes the first `bufferFrame` from the orchestrator (as `activeFrameHandler`).
2. Registers its own `bufferFrame2` as `activeFrameHandler`.

When the first handler's await resolves, `activeFrameHandler` is now `bufferFrame2` (not `bufferFrame`). Without the guard:
- `off("frame", bufferFrame)` is a no-op (already removed).
- `on("frame", onFrame)` **double-registers** `onFrame` — every subsequent frame is sent twice.

**How to apply:** The guard goes immediately after `if (socketClosed) return;` in `ws.gateway.ts`, before the replay `off` + `on` calls.

**File:** `artifacts/api-server/src/modules/broadcast-v2/io/ws.gateway.ts`
