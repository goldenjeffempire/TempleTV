/**
 * Midnight Prayers — time-window unit tests
 *
 * Tests the pure isWindowActive() and getLocalHour() helpers in window-utils.ts.
 * No Fastify, no Drizzle, no DB connection required — these are pure functions.
 *
 * Run with:
 *   node --test --import tsx/esm \
 *     artifacts/api-server/src/modules/midnight-prayers/__tests__/window.test.ts
 *
 * Africa/Lagos is UTC+1 (no DST, year-round). All Lagos timestamps below are
 * constructed using ISO 8601 offset notation (e.g. "2024-01-16T00:00:00+01:00")
 * which Node's Date constructor parses correctly without a third-party library.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWindowActive, getLocalHour, type MPWindowConfig } from "../window-utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a Unix timestamp for a specific local time in Africa/Lagos (UTC+1). */
function lagosMs(isoWithOffset: string): number {
  return new Date(isoWithOffset).getTime();
}

const LAGOS_TZ = "Africa/Lagos";
const EASTERN_TZ = "America/New_York"; // UTC-5 (EST) or UTC-4 (EDT)

/** Standard default window config matching DB defaults. */
const defaultCfg: MPWindowConfig = {
  enabled: true,
  startHour: 0,
  endHour: 3,
  timezone: LAGOS_TZ,
};

// ── getLocalHour() ─────────────────────────────────────────────────────────────

describe("getLocalHour()", () => {
  it("returns 0 for midnight in Africa/Lagos", () => {
    // 2024-01-16T00:00:00+01:00 = midnight Lagos
    const ms = lagosMs("2024-01-16T00:00:00+01:00");
    assert.equal(getLocalHour(LAGOS_TZ, ms), 0);
  });

  it("returns 1 for 1:00 AM in Africa/Lagos", () => {
    const ms = lagosMs("2024-01-16T01:00:00+01:00");
    assert.equal(getLocalHour(LAGOS_TZ, ms), 1);
  });

  it("returns 2 for 2:00 AM in Africa/Lagos", () => {
    const ms = lagosMs("2024-01-16T02:00:00+01:00");
    assert.equal(getLocalHour(LAGOS_TZ, ms), 2);
  });

  it("returns 3 for 3:00 AM in Africa/Lagos", () => {
    const ms = lagosMs("2024-01-16T03:00:00+01:00");
    assert.equal(getLocalHour(LAGOS_TZ, ms), 3);
  });

  it("returns 23 for 11:00 PM in Africa/Lagos", () => {
    const ms = lagosMs("2024-01-15T23:00:00+01:00");
    assert.equal(getLocalHour(LAGOS_TZ, ms), 23);
  });

  it("falls back to UTC hour on invalid timezone", () => {
    const ms = new Date("2024-01-16T12:00:00Z").getTime(); // noon UTC
    const h = getLocalHour("Not/A_Valid_Timezone", ms);
    // Should fall back to UTC: 12
    assert.equal(h, 12);
  });
});

// ── isWindowActive() — primary boundary cases (requirement spec) ────────────────

describe("isWindowActive() — standard window [0, 3) Lagos", () => {

  it("11:59 PM Lagos → BLOCKED (hour=23, outside [0,3))", () => {
    // Jan 15 23:59:00 Lagos
    const ms = lagosMs("2024-01-15T23:59:00+01:00");
    assert.equal(
      isWindowActive(ms, defaultCfg),
      false,
      "11:59 PM must be blocked",
    );
  });

  it("12:00 AM Lagos (midnight) → ALLOWED (hour=0, inside [0,3))", () => {
    // Jan 16 00:00:00 Lagos
    const ms = lagosMs("2024-01-16T00:00:00+01:00");
    assert.equal(
      isWindowActive(ms, defaultCfg),
      true,
      "12:00 AM must be allowed",
    );
  });

  it("12:01 AM Lagos → ALLOWED (hour=0, inside [0,3))", () => {
    const ms = lagosMs("2024-01-16T00:01:00+01:00");
    assert.equal(isWindowActive(ms, defaultCfg), true, "12:01 AM must be allowed");
  });

  it("1:00 AM Lagos → ALLOWED (hour=1, inside [0,3))", () => {
    const ms = lagosMs("2024-01-16T01:00:00+01:00");
    assert.equal(
      isWindowActive(ms, defaultCfg),
      true,
      "1:00 AM must be allowed",
    );
  });

  it("2:59 AM Lagos → ALLOWED (hour=2, inside [0,3))", () => {
    // 2:59:59 — still hour=2
    const ms = lagosMs("2024-01-16T02:59:59+01:00");
    assert.equal(
      isWindowActive(ms, defaultCfg),
      true,
      "2:59 AM must be allowed",
    );
  });

  it("3:00 AM Lagos → BLOCKED (hour=3, equals endHour — exclusive bound)", () => {
    // Critical: the window is [0, 3) — 3:00 AM is NOT included
    const ms = lagosMs("2024-01-16T03:00:00+01:00");
    assert.equal(
      isWindowActive(ms, defaultCfg),
      false,
      "3:00 AM must be blocked (exclusive upper bound)",
    );
  });

  it("3:01 AM Lagos → BLOCKED (hour=3, outside [0,3))", () => {
    const ms = lagosMs("2024-01-16T03:01:00+01:00");
    assert.equal(
      isWindowActive(ms, defaultCfg),
      false,
      "3:01 AM must be blocked",
    );
  });

  it("noon (12:00 PM) Lagos → BLOCKED", () => {
    const ms = lagosMs("2024-01-16T12:00:00+01:00");
    assert.equal(isWindowActive(ms, defaultCfg), false, "Noon must be blocked");
  });

  it("6:00 PM Lagos → BLOCKED", () => {
    const ms = lagosMs("2024-01-16T18:00:00+01:00");
    assert.equal(isWindowActive(ms, defaultCfg), false, "6 PM must be blocked");
  });
});

// ── disabled flag ─────────────────────────────────────────────────────────────

describe("isWindowActive() — enabled=false always returns false", () => {
  const disabledCfg: MPWindowConfig = { ...defaultCfg, enabled: false };

  it("midnight Lagos, disabled → BLOCKED", () => {
    const ms = lagosMs("2024-01-16T00:00:00+01:00");
    assert.equal(isWindowActive(ms, disabledCfg), false);
  });

  it("1:00 AM Lagos, disabled → BLOCKED", () => {
    const ms = lagosMs("2024-01-16T01:00:00+01:00");
    assert.equal(isWindowActive(ms, disabledCfg), false);
  });
});

// ── Zero-length window ────────────────────────────────────────────────────────

describe("isWindowActive() — zero-length window (startHour === endHour)", () => {
  const zeroCfg: MPWindowConfig = {
    enabled: true,
    startHour: 0,
    endHour: 0,
    timezone: LAGOS_TZ,
  };

  it("midnight Lagos, zero-length window → BLOCKED", () => {
    const ms = lagosMs("2024-01-16T00:00:00+01:00");
    assert.equal(isWindowActive(ms, zeroCfg), false);
  });
});

// ── Timezone boundary cases ────────────────────────────────────────────────────

describe("isWindowActive() — timezone boundary cases", () => {

  it("same UTC instant is in-window for Lagos (UTC+1) but midnight+3h out-of-window in NYC (UTC-5)", () => {
    // 2024-01-16T00:30:00+01:00 = 1:30 AM Lagos (in window)
    //                            = 2024-01-15T23:30:00Z
    //                            = 2024-01-15T18:30:00-05:00 (EST) = 6:30 PM New York
    const utcMs = lagosMs("2024-01-16T00:30:00+01:00");

    const lagosCfg: MPWindowConfig = { ...defaultCfg, timezone: LAGOS_TZ };
    const nycCfg: MPWindowConfig   = { ...defaultCfg, timezone: EASTERN_TZ };

    assert.equal(isWindowActive(utcMs, lagosCfg), true,  "1:30 AM Lagos → in window");
    assert.equal(isWindowActive(utcMs, nycCfg),   false, "6:30 PM NYC → out of window");
  });

  it("configured timezone determines window, not UTC hour", () => {
    // 2024-01-16T02:00:00+01:00 = 2:00 AM Lagos (in window)
    // In UTC = 2024-01-16T01:00:00Z = hour 1 UTC (which would be in window for UTC cfg too)
    // Use a Lagos time that is hour 2 (in window) but UTC hour 1 (also in window) —
    // distinguishable by using a timezone that makes UTC 1:00 out of window.

    // Test: 2:00 AM Lagos = UTC 01:00.
    // If config tz were UTC, hour=1 would be in window too.
    // So use a moment where Lagos and UTC differ in outcome:
    //   Lagos 2:00 AM = UTC 01:00 = in window (both startHour=0, endHour=3 for UTC)
    //   Use 3:30 AM Lagos = UTC 02:30 — in window for UTC, but OUT of window for Lagos [0,3).
    const lagosThirtyAm = lagosMs("2024-01-16T03:30:00+01:00");
    // UTC 02:30 → hour=2 → would be IN window if tz were UTC
    const utcCfg: MPWindowConfig   = { ...defaultCfg, timezone: "UTC" };
    const lagosCfg: MPWindowConfig = { ...defaultCfg, timezone: LAGOS_TZ };

    assert.equal(isWindowActive(lagosThirtyAm, utcCfg),   true,  "UTC 02:30 → in UTC window");
    assert.equal(isWindowActive(lagosThirtyAm, lagosCfg), false, "Lagos 03:30 → outside Lagos window");
  });

  it("UTC midnight is in window for UTC config, in window for Lagos too (UTC midnight = Lagos 1:00 AM)", () => {
    const utcMidnight = new Date("2024-01-16T00:00:00Z").getTime();
    const utcCfg: MPWindowConfig   = { ...defaultCfg, timezone: "UTC" };
    const lagosCfg: MPWindowConfig = { ...defaultCfg, timezone: LAGOS_TZ };

    // UTC 00:00 → hour=0 in UTC → in window for UTC config
    assert.equal(isWindowActive(utcMidnight, utcCfg), true, "UTC midnight in UTC window");
    // UTC 00:00 = Lagos 01:00 → hour=1 in Lagos → in window for Lagos config
    assert.equal(isWindowActive(utcMidnight, lagosCfg), true, "UTC midnight = Lagos 1 AM → in Lagos window");
  });
});

// ── Wraparound windows ────────────────────────────────────────────────────────

describe("isWindowActive() — wraparound window (e.g. [22, 2) crosses midnight)", () => {
  const wrapCfg: MPWindowConfig = {
    enabled: true,
    startHour: 22, // 10 PM
    endHour: 2,    // 2 AM
    timezone: LAGOS_TZ,
  };

  it("10:00 PM Lagos → ALLOWED (hour=22, start of wrap window)", () => {
    const ms = lagosMs("2024-01-15T22:00:00+01:00");
    assert.equal(isWindowActive(ms, wrapCfg), true, "10 PM must be allowed");
  });

  it("11:59 PM Lagos → ALLOWED (hour=23, in wraparound portion)", () => {
    const ms = lagosMs("2024-01-15T23:59:00+01:00");
    assert.equal(isWindowActive(ms, wrapCfg), true, "11:59 PM must be allowed (wraparound)");
  });

  it("12:00 AM Lagos → ALLOWED (hour=0, in [0, 2) portion of wrap window)", () => {
    const ms = lagosMs("2024-01-16T00:00:00+01:00");
    assert.equal(isWindowActive(ms, wrapCfg), true, "Midnight must be allowed (wraparound)");
  });

  it("1:00 AM Lagos → ALLOWED (hour=1, in [0, 2) portion)", () => {
    const ms = lagosMs("2024-01-16T01:00:00+01:00");
    assert.equal(isWindowActive(ms, wrapCfg), true, "1 AM must be allowed (wraparound)");
  });

  it("2:00 AM Lagos → BLOCKED (hour=2, equals endHour — exclusive)", () => {
    const ms = lagosMs("2024-01-16T02:00:00+01:00");
    assert.equal(isWindowActive(ms, wrapCfg), false, "2:00 AM must be blocked (exclusive upper)");
  });

  it("9:00 PM Lagos → BLOCKED (hour=21, before start of wrap window)", () => {
    const ms = lagosMs("2024-01-15T21:00:00+01:00");
    assert.equal(isWindowActive(ms, wrapCfg), false, "9 PM must be blocked");
  });

  it("3:00 PM Lagos → BLOCKED (hour=15, mid-day, outside wrap window)", () => {
    const ms = lagosMs("2024-01-15T15:00:00+01:00");
    assert.equal(isWindowActive(ms, wrapCfg), false, "3 PM must be blocked");
  });
});

// ── Recurring schedule boundary — the window opens and closes exactly ──────────

describe("isWindowActive() — precise window boundary at seconds resolution", () => {
  it("2:59:59 AM Lagos (last second inside window) → ALLOWED", () => {
    const ms = lagosMs("2024-01-16T02:59:59+01:00");
    // hour=2 → in [0, 3)
    assert.equal(isWindowActive(ms, defaultCfg), true, "Last second before 3 AM must be allowed");
  });

  it("3:00:00 AM Lagos (first second of excluded hour) → BLOCKED", () => {
    const ms = lagosMs("2024-01-16T03:00:00+01:00");
    // hour=3 → NOT in [0, 3)
    assert.equal(isWindowActive(ms, defaultCfg), false, "First second of 3 AM must be blocked");
  });

  it("11:59:59 PM Lagos (last second of excluded late-night) → BLOCKED", () => {
    const ms = lagosMs("2024-01-15T23:59:59+01:00");
    // hour=23 → NOT in [0, 3)
    assert.equal(isWindowActive(ms, defaultCfg), false, "11:59:59 PM must be blocked");
  });

  it("00:00:00 AM Lagos (exact midnight boundary) → ALLOWED", () => {
    const ms = lagosMs("2024-01-16T00:00:00+01:00");
    // hour=0 → in [0, 3)
    assert.equal(isWindowActive(ms, defaultCfg), true, "Exact midnight must be allowed");
  });
});

// ── getSnapshot() envelope — window enforcement on the snapshot output ────────

describe("isWindowActive() — snapshot-equivalent envelope tests", () => {
  // These tests verify that the window enforcer correctly categorises times
  // that a real getSnapshot() call would process, using the same logic.

  const times: Array<[string, string, boolean]> = [
    // [label, ISO+offset for Lagos, expectedActive]
    ["11:59 PM",  "2024-01-15T23:59:00+01:00", false],
    ["12:00 AM",  "2024-01-16T00:00:00+01:00", true ],
    ["12:30 AM",  "2024-01-16T00:30:00+01:00", true ],
    ["1:00 AM",   "2024-01-16T01:00:00+01:00", true ],
    ["2:00 AM",   "2024-01-16T02:00:00+01:00", true ],
    ["2:59 AM",   "2024-01-16T02:59:00+01:00", true ],
    ["3:00 AM",   "2024-01-16T03:00:00+01:00", false],
    ["3:01 AM",   "2024-01-16T03:01:00+01:00", false],
    ["6:00 AM",   "2024-01-16T06:00:00+01:00", false],
    ["12:00 PM",  "2024-01-16T12:00:00+01:00", false],
    ["11:00 PM",  "2024-01-16T23:00:00+01:00", false],
  ];

  for (const [label, iso, expected] of times) {
    it(`${label} Lagos → ${expected ? "ALLOWED" : "BLOCKED"}`, () => {
      const ms = lagosMs(iso);
      assert.equal(
        isWindowActive(ms, defaultCfg),
        expected,
        `${label}: expected ${expected ? "allowed" : "blocked"}`,
      );
    });
  }
});
