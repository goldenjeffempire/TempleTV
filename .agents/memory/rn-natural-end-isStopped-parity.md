---
name: RN/web natural-end guard parity
description: react.ts and react-native.ts natural-end retry chains must both carry transport.isStopped guards or evicted sessions leak forever.
---

# Natural-end retry guard parity (web ↔ native)

Both player-core broadcast hooks register a `setNaturalEndCallback` whose handler
POSTs `/natural-end` and calls `transport.requestSnapshot()`, retrying on failure.

**Rule:** that callback MUST guard with `if (transport.isStopped) return;` in TWO
places — once before the POST, once inside the `.catch()` before the retry/snapshot
path — in *both* `react.ts` (web) and `react-native.ts` (native).

**Why:** the native hook originally shipped without the guards. After a session was
evicted (`machine.destroy()` + `transport.stop()`), the natural-end callback kept
firing POST `/natural-end` + `requestSnapshot()` forever — a battery and network
drain on mobile that no teardown could stop. The web hook always had the guards, so
the two drifted out of parity.

**How to apply:** any edit to the natural-end retry chain in one hook must be
mirrored in the other. `lib/player-core/tests/regression.test.ts` "Bug 8b" is a
structural tripwire: it reads both source files and asserts each
`setNaturalEndCallback` block contains ≥2 `transport.isStopped` guards. The runtime
bail behavior itself is covered by the "Bug 8" mock-transport tests in the same file.
Note this is a parity/text check, not a hook-render test — player-core's vitest env
is `node` with no RN renderer, and `getOrCreateSession` is module-private.
