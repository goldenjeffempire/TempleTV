---
name: Player-core vendor sync — mobile vendor divergence rules
description: Mobile uses a vendored copy of player-core; changes to lib/ must also be applied to artifacts/mobile/vendor/player-core/.
---

## Rule
`artifacts/mobile/vendor/player-core/` is a vendored copy of `lib/player-core/`.
Any change to `lib/player-core/src/` MUST be mirrored in `artifacts/mobile/vendor/player-core/src/`.

Critical files that must stay in sync:
- `react-native.ts` — naturalEndRetryDelays, transport constants
- `machine.ts` — FSM constants (MAX_PRIMARY_RETRIES, etc.)
- `transport.ts` — WS/SSE timing constants
- `types.ts` — V2SourceQuality, V2Snapshot, V2Item shapes

**Why:** `artifacts/mobile/package.json` depends on `file:./vendor/player-core`, not
the canonical `lib/player-core`. A change to lib only is a no-op for mobile at runtime.

**How to apply:** After every lib/player-core edit, diff the two trees:
```
diff -r lib/player-core/src/ artifacts/mobile/vendor/player-core/src/
```
Apply all semantic differences (not just formatting/comment-only) to the vendor copy.

## Faststart pipeline — sourceQuality type alignment (July 2026)
The faststart pipeline was removed; API now always sends `sourceQuality: "mp4"`.
The vendor types.ts had `V2SourceQuality = "hls" | "mp4_faststart" | "mp4_raw"` (stale).
Fix applied: both lib and vendor now use `"hls" | "mp4" | "mp4_faststart" | "mp4_raw"` 
(mp4_faststart/mp4_raw kept as backward-compat union members).

V2PlayerContainer badge check fixed: `sq === "mp4_faststart"` → `sq === "mp4" || sq === "mp4_faststart"`
so the "MP4" label shows correctly with the current API output.

## naturalEndRetryDelays alignment (July 2026)
Mobile vendor had `[2_000, 4_000, 8_000]` ms; web react.ts uses `[300, 800, 2_000]` ms.
Both lib and vendor now use `[300, 800, 2_000]` ms — worst-case item-transition gap on
mobile drops from ~14 s to ~3.1 s when the first POST /natural-end fails.
