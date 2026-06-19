---
name: Continue Watching cross-device sync
description: durationSecs column added to user_watch_history; dedicated continue-watching endpoint pattern
---

## Schema change
`user_watch_history.duration_secs` — nullable integer. Null = client never sent duration (treated as "not completed" conservatively).

## POST /user/history guard
When `durationSecs` is provided in body, only update in onConflictDoUpdate if it's not null — prevents overwriting a known duration with null from a minimal heartbeat payload:
```typescript
...(durationSecs != null ? { durationSecs } : {})
```

## GET /user/continue-watching logic
- Filter at DB: `progressSecs > 30` (meaningful start)
- Filter in JS: `durationSecs == null || progressSecs / durationSecs < 0.95` (not completed)
- Fetch `limit * 3` rows from DB so JS filter doesn't shrink result below limit
- HistoryItemSchema now includes `durationSecs: z.number().int().nullable()`

**Why:** Cross-device resume requires knowing both position and duration. Storing both together avoids a JOIN to managed_videos on every continue-watching query.
