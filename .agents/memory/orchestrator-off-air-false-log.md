---
name: orchestrator reloadInner OFF_AIR false log
description: When an override is active, reloadInner must log ON_AIR via active override — not OFF_AIR — regardless of queue state.
---

## The Rule

In `broadcast-orchestrator.ts → reloadInner()`, the empty-queue branch must distinguish between:

1. **Override active** (`this.mode === "override" && this.override != null`): log `"ON_AIR via active override"` — the channel is on-air even though the local queue is empty.
2. **Truly off-air** (no override, empty queue): log `"OFF_AIR — no playable content"`.

```ts
if (this.mode === "override" && this.override) {
  logger.info({ ..., overrideTitle: this.override.title }, "[broadcast-v2] reloadInner: local queue is empty — broadcast is ON_AIR via active override");
} else {
  logger.info({ ... }, "[broadcast-v2] reloadInner: no playable local content — broadcast is OFF_AIR");
}
```

**Why:** The YouTube shuffle fallback activates as an override every 30s after boot. Before this fix, the operator saw repeated `OFF_AIR` INFO lines even though viewers were watching a YouTube override — creating false alarm noise in logs and monitoring dashboards.

**How to apply:** Any time the empty-queue log path is touched in `reloadInner`, preserve the override guard.
