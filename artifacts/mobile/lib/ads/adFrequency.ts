/**
 * adFrequency — pure, side-effect-free helpers for ad frequency capping and
 * retry backoff. No React, no native modules — fully unit-testable.
 *
 * Two independent concerns live here:
 *   1. FrequencyCapper — enforces per-key cooldowns and per-session impression
 *      caps so the app never over-serves ads (bad UX + Google policy risk).
 *   2. nextBackoffDelay — full-jitter exponential backoff for retrying failed
 *      ad loads without hammering the network / ad server.
 */

export interface FrequencyRule {
  /** Minimum milliseconds between two impressions for the same key. */
  cooldownMs: number;
  /** Maximum impressions allowed for this key within the current session. */
  maxPerSession?: number;
}

interface KeyState {
  lastShownAt: number;
  countThisSession: number;
}

/**
 * In-memory frequency capper. State is intentionally NOT persisted across app
 * restarts — a fresh session is an acceptable and expected reset point for a
 * 24/7 broadcast app, and it avoids the failure modes of corrupt persisted
 * counters blocking all ads.
 */
export class FrequencyCapper {
  private readonly rules: Partial<Record<string, FrequencyRule>>;
  private readonly state = new Map<string, KeyState>();

  constructor(rules: Partial<Record<string, FrequencyRule>> = {}) {
    this.rules = rules;
  }

  /** Returns true when an impression for `key` is allowed at time `now`. */
  canShow(key: string, now: number = Date.now()): boolean {
    const rule = this.rules[key];
    if (!rule) return true; // No rule configured → always allowed.
    const s = this.state.get(key);
    if (!s) return true;
    if (
      typeof rule.maxPerSession === "number" &&
      s.countThisSession >= rule.maxPerSession
    ) {
      return false;
    }
    return now - s.lastShownAt >= rule.cooldownMs;
  }

  /** Record that an impression for `key` was shown at time `now`. */
  markShown(key: string, now: number = Date.now()): void {
    const prev = this.state.get(key);
    this.state.set(key, {
      lastShownAt: now,
      countThisSession: (prev?.countThisSession ?? 0) + 1,
    });
  }

  /** Milliseconds until `key` becomes eligible again (0 when already eligible). */
  msUntilEligible(key: string, now: number = Date.now()): number {
    const rule = this.rules[key];
    if (!rule) return 0;
    const s = this.state.get(key);
    if (!s) return 0;
    if (
      typeof rule.maxPerSession === "number" &&
      s.countThisSession >= rule.maxPerSession
    ) {
      return Number.POSITIVE_INFINITY; // Session cap reached.
    }
    return Math.max(0, rule.cooldownMs - (now - s.lastShownAt));
  }

  /** How many impressions of `key` have been shown this session. */
  shownCount(key: string): number {
    return this.state.get(key)?.countThisSession ?? 0;
  }

  /** Reset all counters (e.g. on a fresh cold start controller mount). */
  reset(): void {
    this.state.clear();
  }
}

/**
 * Full-jitter exponential backoff. Returns a delay in milliseconds for the
 * given zero-based retry attempt.
 *
 *   base * 2^attempt, capped at maxDelayMs, then randomised in [minFloor, cap]
 *   so a fleet of clients recovering from an outage does not thundering-herd
 *   the ad server.
 *
 * The minimum return value is `floor(baseDelayMs / 4)` (500 ms for the default
 * 2 s base). Without this floor, full-jitter can produce a 0 ms delay on the
 * very first retry when `rng()` is close to 0, causing the SDK to be hammered
 * in a tight synchronous loop.
 *
 * @param attempt     zero-based attempt index (0 = first retry)
 * @param baseDelayMs base delay (default 2s)
 * @param maxDelayMs  ceiling (default 60s)
 * @param rng         injectable RNG for deterministic tests (default Math.random)
 */
export function nextBackoffDelay(
  attempt: number,
  baseDelayMs = 2_000,
  maxDelayMs = 60_000,
  rng: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  // Guard against overflow for very large attempt counts.
  const exp = Math.min(safeAttempt, 30);
  const uncapped = baseDelayMs * 2 ** exp;
  const cap = Math.min(uncapped, maxDelayMs);
  // Always return at least baseDelayMs/4 so that even the first retry (where
  // full-jitter could otherwise yield 0 ms) still waits a meaningful interval.
  const minFloor = Math.floor(baseDelayMs / 4);
  return Math.max(minFloor, Math.floor(rng() * cap));
}
