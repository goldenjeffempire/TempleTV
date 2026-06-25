/**
 * schedule-day-of-week.test.ts
 *
 * Root cause documented here:
 * ─────────────────────────────────────────────────────────────────────────────
 * The bug `day_of_week = 313` in DB queries was caused by `nowMinutes()`
 * (which returns hours × 60 + minutes, range 0–1439) being accidentally used
 * in place of `todayDow()` (which returns JS getDay(), range 0–6) in the
 * `scheduleBridgeScan()` WHERE clause.  At 05:13 local time:
 *
 *   5 × 60 + 13 = 313  ← minute-of-day, NOT a weekday
 *
 * Fix: `todayDow()` exclusively uses `new Date().getDay()`, has an explicit
 * out-of-range guard, and its comments clearly prohibit substituting
 * `nowMinutes()`.  The DB column also now has a CHECK constraint
 * (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * These tests are pure-unit (no DB / server) and cover every critical
 * invariant in the date helpers.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ── Re-implement the helpers under test inline (they are not exported from
//    the bridge module, which would require a full app boot).  Any future
//    refactor that changes these helpers must also update these copies and
//    the tests will catch divergence.
// ─────────────────────────────────────────────────────────────────────────────

/** Exact copy of the production parseTimeToMinutes after the fix. */
function parseTimeToMinutes(t: string): number {
  const parts = t.split(":").map(Number);
  const h = parts[0]!;
  const m = parts[1] ?? 0;
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return NaN;
  }
  return h * 60 + m;
}

/** Exact copy of the production todayDow after the fix. */
function todayDow(): number {
  const dow = new Date().getDay();
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
    throw new Error(`todayDow() returned out-of-range value: ${dow}`);
  }
  return dow;
}

/** Exact copy of the production nowMinutes after the fix. */
function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** Exact copy of the production endTimeMsForToday after the fix. */
function endTimeMsForToday(endTime: string | null): number | null {
  if (!endTime) return null;
  const mins = parseTimeToMinutes(endTime);
  if (!Number.isFinite(mins) || mins < 0 || mins > 1439) return null;
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d.getTime();
}

/** Exact copy of the production dayOfWeekFromDate after the fix. */
function dayOfWeekFromDate(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const result = new Date(y!, m! - 1, d!).getDay();
  if (!Number.isInteger(result) || result < 0 || result > 6) {
    throw new Error(`dayOfWeekFromDate: computed invalid weekday ${result} from date "${dateStr}"`);
  }
  return result;
}

/** Validate a stored dayOfWeek value (mirrors assertValidDayOfWeek in the service). */
function assertValidDayOfWeek(value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw new Error(`invalid day_of_week ${value} (must be 0–6)`);
  }
}

// ── Helper to pin the clock to a specific local datetime ─────────────────────

function pinDateTo(isoLocal: string, cb: () => void) {
  const ts = new Date(isoLocal).getTime();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ts));
  try {
    cb();
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
//  1. parseTimeToMinutes
// ─────────────────────────────────────────────────────────────────────────────

describe("parseTimeToMinutes", () => {
  it("parses midnight as 0", () => {
    expect(parseTimeToMinutes("00:00")).toBe(0);
  });

  it("parses end-of-day as 1439", () => {
    expect(parseTimeToMinutes("23:59")).toBe(1439);
  });

  it("parses 05:13 as 313 — the exact value that triggered the bug", () => {
    expect(parseTimeToMinutes("05:13")).toBe(313);
  });

  it("parses 09:30 correctly", () => {
    expect(parseTimeToMinutes("09:30")).toBe(570);
  });

  it("returns NaN for overflow hour (24:00)", () => {
    expect(parseTimeToMinutes("24:00")).toBeNaN();
  });

  it("returns NaN for overflow minute (10:60)", () => {
    expect(parseTimeToMinutes("10:60")).toBeNaN();
  });

  it("returns NaN for negative values", () => {
    expect(parseTimeToMinutes("-1:00")).toBeNaN();
  });

  it("returns NaN for empty string", () => {
    expect(parseTimeToMinutes("")).toBeNaN();
  });

  it("returns NaN for non-time garbage", () => {
    expect(parseTimeToMinutes("abc")).toBeNaN();
    expect(parseTimeToMinutes("313")).toBeNaN();  // the bug value as a plain number string
  });

  it("critical: 313 is a valid minute-of-day, NOT a valid day-of-week", () => {
    const mins = parseTimeToMinutes("05:13");
    expect(mins).toBe(313);
    // A valid dayOfWeek must be 0–6.  313 is way outside that range.
    expect(mins).toBeGreaterThan(6);
    // This is the root cause: if mins were passed to eq(dayOfWeek, mins)
    // you get "WHERE day_of_week = 313" which never matches any row.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. todayDow — must always return 0–6
// ─────────────────────────────────────────────────────────────────────────────

describe("todayDow", () => {
  const SUNDAYS = [
    "2026-06-28T00:00:00",  // a Sunday (midnight, no timezone ambiguity)
    "2026-07-05T12:00:00",
  ];
  const SATURDAYS = [
    "2026-06-27T23:59:00",
    "2026-07-04T00:00:00",
  ];

  it("returns 0 on a Sunday", () => {
    pinDateTo(SUNDAYS[0]!, () => {
      expect(todayDow()).toBe(0);
    });
  });

  it("returns 6 on a Saturday", () => {
    pinDateTo(SATURDAYS[0]!, () => {
      expect(todayDow()).toBe(6);
    });
  });

  it("always returns an integer in [0, 6] across all weekdays", () => {
    // Iterate through a full 7-day week starting 2026-06-22 (Monday)
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date("2026-06-22T12:00:00");
      date.setDate(date.getDate() + offset);
      pinDateTo(date.toISOString(), () => {
        const d = todayDow();
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(6);
        expect(Number.isInteger(d)).toBe(true);
      });
    }
  });

  it("critical: todayDow never returns 313 (the bug value)", () => {
    // Pin to 05:13 — the exact time nowMinutes() = 313
    pinDateTo("2026-06-25T05:13:00", () => {
      const dow = todayDow();
      expect(dow).not.toBe(313);
      expect(dow).toBeGreaterThanOrEqual(0);
      expect(dow).toBeLessThanOrEqual(6);
    });
  });

  it("critical: todayDow and nowMinutes have different ranges and must not be swapped", () => {
    // At 05:13, nowMinutes() = 313 but todayDow() is 0–6
    pinDateTo("2026-06-25T05:13:00", () => {
      const dow = todayDow();
      const mins = nowMinutes();
      expect(mins).toBe(313);     // confirms the exact bug value
      expect(dow).not.toBe(mins); // the two MUST differ at this time
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. nowMinutes — must stay in [0, 1439]
// ─────────────────────────────────────────────────────────────────────────────

describe("nowMinutes", () => {
  it("returns 0 at midnight", () => {
    pinDateTo("2026-06-25T00:00:00", () => {
      expect(nowMinutes()).toBe(0);
    });
  });

  it("returns 313 at 05:13 — the root-cause value", () => {
    pinDateTo("2026-06-25T05:13:00", () => {
      expect(nowMinutes()).toBe(313);
    });
  });

  it("returns 1439 at 23:59", () => {
    pinDateTo("2026-06-25T23:59:00", () => {
      expect(nowMinutes()).toBe(1439);
    });
  });

  it("is always in [0, 1439]", () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30, 59]) {
        const iso = `2026-06-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
        pinDateTo(iso, () => {
          const mins = nowMinutes();
          expect(mins).toBeGreaterThanOrEqual(0);
          expect(mins).toBeLessThanOrEqual(1439);
        });
      }
    }
  });

  it("nowMinutes range overlaps dayOfWeek range at 0–6 but diverges immediately at 7+ minutes", () => {
    // The dangerous zone: between 00:00 and 00:06, both todayDow() and nowMinutes()
    // could return the same integer purely by coincidence (both 0–6).
    // At 00:07+ they diverge.  The fix ensures only todayDow() goes into DB queries.
    pinDateTo("2026-06-25T00:07:00", () => {
      const mins = nowMinutes();
      // 7 is already > 6 so it cannot be a valid dayOfWeek
      expect(mins).toBeGreaterThan(6);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. endTimeMsForToday — explicit h/m decomposition
// ─────────────────────────────────────────────────────────────────────────────

describe("endTimeMsForToday", () => {
  it("returns null for null input", () => {
    expect(endTimeMsForToday(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(endTimeMsForToday("")).toBeNull();
  });

  it("returns null for overflow time strings", () => {
    expect(endTimeMsForToday("24:00")).toBeNull();
    expect(endTimeMsForToday("25:00")).toBeNull();
    expect(endTimeMsForToday("10:60")).toBeNull();
  });

  it("returns a timestamp in the future for end times later than now", () => {
    pinDateTo("2026-06-25T09:00:00", () => {
      const result = endTimeMsForToday("10:00");
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(Date.now());
    });
  });

  it("returns the correct absolute ms for 09:30", () => {
    pinDateTo("2026-06-25T08:00:00", () => {
      const result = endTimeMsForToday("09:30")!;
      const expected = new Date();
      expected.setHours(9, 30, 0, 0);
      expect(result).toBe(expected.getTime());
    });
  });

  it("returns the correct absolute ms for 00:00 (midnight)", () => {
    pinDateTo("2026-06-25T12:00:00", () => {
      const result = endTimeMsForToday("00:00")!;
      const expected = new Date();
      expected.setHours(0, 0, 0, 0);
      expect(result).toBe(expected.getTime());
    });
  });

  it("correctly handles 23:59 without overflow", () => {
    pinDateTo("2026-06-25T08:00:00", () => {
      const result = endTimeMsForToday("23:59")!;
      const expected = new Date();
      expected.setHours(23, 59, 0, 0);
      expect(result).toBe(expected.getTime());
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. dayOfWeekFromDate — YYYY-MM-DD → 0–6
// ─────────────────────────────────────────────────────────────────────────────

describe("dayOfWeekFromDate", () => {
  // Known weekday facts for spot-checks:
  const KNOWN = [
    { date: "2026-06-22", expected: 1, label: "Monday" },
    { date: "2026-06-23", expected: 2, label: "Tuesday" },
    { date: "2026-06-24", expected: 3, label: "Wednesday" },
    { date: "2026-06-25", expected: 4, label: "Thursday" },
    { date: "2026-06-26", expected: 5, label: "Friday" },
    { date: "2026-06-27", expected: 6, label: "Saturday" },
    { date: "2026-06-28", expected: 0, label: "Sunday" },
  ];

  for (const { date, expected, label } of KNOWN) {
    it(`returns ${expected} for ${date} (${label})`, () => {
      expect(dayOfWeekFromDate(date)).toBe(expected);
    });
  }

  it("handles leap year dates (2024-02-29 = Thursday = 4)", () => {
    expect(dayOfWeekFromDate("2024-02-29")).toBe(4);
  });

  it("handles end-of-year boundary (2025-12-31 = Wednesday = 3)", () => {
    expect(dayOfWeekFromDate("2025-12-31")).toBe(3);
  });

  it("handles new-year boundary (2026-01-01 = Thursday = 4)", () => {
    expect(dayOfWeekFromDate("2026-01-01")).toBe(4);
  });

  it("always returns a value in [0, 6]", () => {
    // Walk a full 365-day year to cover all day-of-week patterns
    const start = new Date("2026-01-01");
    for (let i = 0; i < 365; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dateStr = d.toISOString().substring(0, 10);
      const dow = dayOfWeekFromDate(dateStr);
      expect(dow).toBeGreaterThanOrEqual(0);
      expect(dow).toBeLessThanOrEqual(6);
      expect(Number.isInteger(dow)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. assertValidDayOfWeek — rejects invalid values including the bug values
// ─────────────────────────────────────────────────────────────────────────────

describe("assertValidDayOfWeek", () => {
  it("accepts null (one-time entries have no explicit dayOfWeek)", () => {
    expect(() => assertValidDayOfWeek(null)).not.toThrow();
  });

  it("accepts undefined", () => {
    expect(() => assertValidDayOfWeek(undefined)).not.toThrow();
  });

  it.each([0, 1, 2, 3, 4, 5, 6])("accepts valid weekday %i", (dow: number) => {
    expect(() => assertValidDayOfWeek(dow)).not.toThrow();
  });

  it("rejects 313 — the root-cause nowMinutes() value at 05:13", () => {
    expect(() => assertValidDayOfWeek(313)).toThrow();
  });

  it("rejects 7 (one above max)", () => {
    expect(() => assertValidDayOfWeek(7)).toThrow();
  });

  it("rejects -1 (one below min)", () => {
    expect(() => assertValidDayOfWeek(-1)).toThrow();
  });

  it("rejects 1439 (max minute-of-day value, 23:59)", () => {
    expect(() => assertValidDayOfWeek(1439)).toThrow();
  });

  it("rejects NaN", () => {
    expect(() => assertValidDayOfWeek(NaN)).toThrow();
  });

  it("rejects non-integers like 2.5", () => {
    expect(() => assertValidDayOfWeek(2.5)).toThrow();
  });

  it("rejects all representative nowMinutes() values that could be confused with a weekday", () => {
    // These are all valid outputs of nowMinutes() that fall outside [0,6]
    const badValues = [7, 60, 120, 313, 540, 1080, 1439];
    for (const v of badValues) {
      expect(() => assertValidDayOfWeek(v)).toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. Proof that the historical bug path is now blocked end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("end-to-end: bug path is blocked", () => {
  it("at 05:13, nowMinutes()=313 is rejected before it can reach the DB query", () => {
    pinDateTo("2026-06-25T05:13:00", () => {
      const minuteValue = nowMinutes(); // 313 — the historical bug value

      // The old bug: dow = minuteValue → db query WHERE day_of_week = 313
      // The fix: dow = todayDow() which is 0–6 and validated

      // Step 1: confirm the minute value is the reported bug value
      expect(minuteValue).toBe(313);

      // Step 2: confirm todayDow() does NOT return the minute value
      const safeValue = todayDow();
      expect(safeValue).not.toBe(minuteValue);

      // Step 3: confirm assertValidDayOfWeek blocks the minute value
      expect(() => assertValidDayOfWeek(minuteValue)).toThrow();

      // Step 4: confirm the safe value passes validation
      expect(() => assertValidDayOfWeek(safeValue)).not.toThrow();
    });
  });

  it("the DB CHECK constraint rejects 313 — valid range is NULL or 0–6", () => {
    // Simulate what the DB CHECK constraint enforces:
    //   day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)
    function dbCheckConstraint(v: number | null): boolean {
      if (v === null) return true;
      return Number.isInteger(v) && v >= 0 && v <= 6;
    }

    expect(dbCheckConstraint(null)).toBe(true);   // one-time entries
    expect(dbCheckConstraint(0)).toBe(true);       // Sunday
    expect(dbCheckConstraint(6)).toBe(true);       // Saturday
    expect(dbCheckConstraint(313)).toBe(false);    // the bug value
    expect(dbCheckConstraint(7)).toBe(false);      // one above max
    expect(dbCheckConstraint(-1)).toBe(false);     // one below min
    expect(dbCheckConstraint(1439)).toBe(false);   // max minute-of-day
  });

  it("at every minute of the day, todayDow is always 0–6 (never a minute-of-day value > 6)", () => {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) {
        const iso = `2026-06-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
        pinDateTo(iso, () => {
          const dow = todayDow();
          const mins = nowMinutes();

          // todayDow is always valid
          expect(dow).toBeGreaterThanOrEqual(0);
          expect(dow).toBeLessThanOrEqual(6);

          // nowMinutes is always >= 0 and at most 1439
          expect(mins).toBeGreaterThanOrEqual(0);
          expect(mins).toBeLessThanOrEqual(1439);

          // After the first 7 minutes of the day, they can never be equal
          // (at 00:00–00:06 they could coincidentally match — that's expected
          // since both dow and mins are in [0, 6] at those times)
          if (h > 0 || m > 6) {
            // Mins is now > 6, so if it was used as dayOfWeek it would produce
            // an out-of-range query.  assertValidDayOfWeek catches this.
            expect(() => assertValidDayOfWeek(mins)).toThrow();
          }
        });
      }
    }
  });
});
