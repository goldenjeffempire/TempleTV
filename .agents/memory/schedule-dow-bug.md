---
name: schedule day_of_week=313 bug
description: Root cause and fix for scheduler producing WHERE day_of_week=313 queries
---

## Root cause
`nowMinutes()` returns `getHours()*60 + getMinutes()` (range 0–1439). At **05:13** local time this equals **313** — a minute-of-day value. When accidentally passed to `eq(sched.dayOfWeek, ...)` instead of `todayDow()` (which calls `getDay()`, range 0–6), the DB query becomes `WHERE day_of_week = 313`, which never matches any valid row.

`313 = 5 × 60 + 13` — the exact minute offset for 05:13.

## Fixes applied (June 2026)
1. **`schedule-bridge.ts`**
   - `parseTimeToMinutes`: now returns `NaN` for out-of-range h/m (was silent overflow)
   - `todayDow`: added explicit `0–6` guard + throw; JSDoc warning not to substitute `nowMinutes()`
   - `endTimeMsForToday`: replaced `setHours(0, totalMins, 0, 0)` with explicit `setHours(h, m, 0, 0)` decomposition
   - `scheduleBridgeScan`: `todayDow()` wrapped in try/catch (aborts scan on error); stored invalid `dayOfWeek` values in returned rows are logged as ERROR

2. **`schedule.service.ts`**
   - `dayOfWeekFromDate`: throws if `getDay()` result is not 0–6
   - `assertValidDayOfWeek(value, context)`: new helper, rejects anything outside 0–6 (including 313, NaN, floats)
   - Called in `create()` and `update()` before every DB write

3. **`lib/db/src/schema/schedule.ts`**
   - Added `check("chk_schedule_day_of_week_valid", sql\`... IS NULL OR (... >= 0 AND ... <= 6)\`)`
   - Applied via `pnpm --filter @workspace/db run push`
   - DB-level proof: inserting 313, -1, 7 all raise `chk_schedule_day_of_week_valid` violation

4. **Test file**: `artifacts/api-server/tests/unit/schedule-day-of-week.test.ts` (47 vitest tests)

## Why
`nowMinutes()` and `todayDow()` were both small integers named `dow`/`currentMin` and it was easy to swap them in the WHERE clause. The fix adds defence at every layer: parse, compute, service, DB.
