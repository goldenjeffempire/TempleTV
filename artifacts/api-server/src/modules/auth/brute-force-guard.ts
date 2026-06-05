/**
 * In-process brute-force guard for auth endpoints.
 *
 * Tracks failed credential attempts per source IP and per email address
 * independently. Once either key accumulates AUTH_BF_MAX_ATTEMPTS failures
 * within AUTH_BF_WINDOW_MS the key is locked for the remainder of that window
 * and all further attempts on that key return 429 with a Retry-After header.
 *
 * Complementary to — not a replacement for — the @fastify/rate-limit plugin.
 * Rate-limit counts ALL requests; this guard counts only CREDENTIAL FAILURES,
 * so a single attacker hammering a single account from many IPs triggers a
 * per-account lockout (and vice-versa for a single IP targeting many accounts).
 *
 * Design choices:
 *   - Pure in-process: zero DB/Redis dependency — always on, zero latency.
 *   - Fixed lockout window: once triggered, the lock runs for AUTH_BF_WINDOW_MS
 *     regardless of additional attempts (prevents lockout extension attacks).
 *   - Admin bypass: X-Bypass-Rate-Limit header with AUTH_BF_BYPASS_TOKEN skips
 *     both the IP and account check (intended for server-to-server tooling only).
 *   - GC: stale entries are lazily pruned on access and by a background timer.
 */

import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";
import { safeStringEqual } from "../../middleware/auth.js";
import { captureEvent } from "../../infrastructure/sentry.js";

interface BucketEntry {
  /** Timestamps (ms) of failed attempts still within the sliding window. */
  failTimes: number[];
  /** If > Date.now(), this key is locked out. 0 = not locked. */
  lockedUntilMs: number;
}

const ipBuckets   = new Map<string, BucketEntry>();
const emailBuckets = new Map<string, BucketEntry>();

// Background GC: sweep both maps every 5 minutes to release memory held by
// expired entries during quiet periods (no traffic to trigger lazy pruning).
const _gcTimer = setInterval(() => {
  const now = Date.now();
  const windowMs = env.AUTH_BF_WINDOW_MS;
  for (const [k, v] of ipBuckets) {
    // Prune stale fail-times before checking. Without the prune step a
    // slow-drip attacker (one failure per window interval) keeps one
    // failTime permanently inside the window, preventing GC and allowing
    // the Map to grow to O(distinct IPs) over time.
    v.failTimes = v.failTimes.filter((t) => now - t <= windowMs);
    if (v.lockedUntilMs <= now && v.failTimes.length === 0) {
      ipBuckets.delete(k);
    }
  }
  for (const [k, v] of emailBuckets) {
    v.failTimes = v.failTimes.filter((t) => now - t <= windowMs);
    if (v.lockedUntilMs <= now && v.failTimes.length === 0) {
      emailBuckets.delete(k);
    }
  }
}, 5 * 60_000);
_gcTimer.unref?.();

function getBucket(map: Map<string, BucketEntry>, key: string): BucketEntry {
  let entry = map.get(key);
  if (!entry) {
    entry = { failTimes: [], lockedUntilMs: 0 };
    map.set(key, entry);
  }
  return entry;
}

function pruneWindow(entry: BucketEntry): void {
  const cutoff = Date.now() - env.AUTH_BF_WINDOW_MS;
  entry.failTimes = entry.failTimes.filter((t) => t > cutoff);
}

function checkEntry(entry: BucketEntry): { blocked: boolean; retryAfterSecs: number } {
  const now = Date.now();
  if (entry.lockedUntilMs > now) {
    return { blocked: true, retryAfterSecs: Math.ceil((entry.lockedUntilMs - now) / 1000) };
  }
  pruneWindow(entry);
  if (entry.failTimes.length >= env.AUTH_BF_MAX_ATTEMPTS) {
    // Threshold hit — lock it now (lazy lock: wasn't locked on the way in but
    // count is at the limit, which can happen if the lock expired but the
    // window hasn't yet cleared).
    entry.lockedUntilMs = now + env.AUTH_BF_WINDOW_MS;
    return { blocked: true, retryAfterSecs: Math.ceil(env.AUTH_BF_WINDOW_MS / 1000) };
  }
  return { blocked: false, retryAfterSecs: 0 };
}

/**
 * Check whether the given IP or email is currently locked out.
 * Call this BEFORE the password-hash comparison so a locked-out key never
 * reaches the intentionally-slow bcrypt/argon2 work factor.
 *
 * @returns `{ blocked, retryAfterSecs, reason }` — blocked=false when allowed.
 */
export function checkBruteForce(
  ip: string,
  email: string,
  bypassToken?: string,
): { blocked: boolean; retryAfterSecs: number; reason: string } {
  if (
    bypassToken &&
    env.AUTH_BF_BYPASS_TOKEN &&
    safeStringEqual(bypassToken, env.AUTH_BF_BYPASS_TOKEN)
  ) {
    return { blocked: false, retryAfterSecs: 0, reason: "" };
  }

  const ipEntry = ipBuckets.get(ip);
  if (ipEntry) {
    const r = checkEntry(ipEntry);
    if (r.blocked) return { ...r, reason: "ip" };
  }

  const emailKey = email.toLowerCase();
  const emailEntry = emailBuckets.get(emailKey);
  if (emailEntry) {
    const r = checkEntry(emailEntry);
    if (r.blocked) return { ...r, reason: "account" };
  }

  return { blocked: false, retryAfterSecs: 0, reason: "" };
}

/**
 * Record a failed login attempt for an IP + email pair.
 * Call this ONLY for credential errors (wrong password / unknown email), not
 * for 5xx server errors — a transient DB outage should not lock users out.
 */
export function recordFailedAttempt(ip: string, email: string): void {
  const now = Date.now();
  const max = env.AUTH_BF_MAX_ATTEMPTS;

  // Per-IP bucket
  const ipEntry = getBucket(ipBuckets, ip);
  pruneWindow(ipEntry);
  ipEntry.failTimes.push(now);
  if (ipEntry.failTimes.length >= max && ipEntry.lockedUntilMs <= now) {
    ipEntry.lockedUntilMs = now + env.AUTH_BF_WINDOW_MS;
    logger.warn(
      { ip, attempts: ipEntry.failTimes.length, lockedUntilMs: ipEntry.lockedUntilMs },
      "[brute-force-guard] IP locked out after too many failed login attempts",
    );
    void captureEvent(
      `Brute-force lockout: IP ${ip} exceeded ${max} failed login attempts`,
      "warning",
      { ip, attempts: ipEntry.failTimes.length, windowMs: env.AUTH_BF_WINDOW_MS },
    );
  }

  // Per-email bucket (log email in a privacy-safe truncated form)
  const emailKey = email.toLowerCase();
  const emailEntry = getBucket(emailBuckets, emailKey);
  pruneWindow(emailEntry);
  emailEntry.failTimes.push(now);
  if (emailEntry.failTimes.length >= max && emailEntry.lockedUntilMs <= now) {
    emailEntry.lockedUntilMs = now + env.AUTH_BF_WINDOW_MS;
    const safeEmail = emailKey.replace(/^(.{2}).*(@.+)$/, "$1***$2");
    logger.warn(
      { email: safeEmail, attempts: emailEntry.failTimes.length, lockedUntilMs: emailEntry.lockedUntilMs },
      "[brute-force-guard] Account locked out after too many failed login attempts",
    );
    void captureEvent(
      `Brute-force lockout: account ${safeEmail} exceeded ${max} failed login attempts`,
      "warning",
      { email: safeEmail, attempts: emailEntry.failTimes.length, windowMs: env.AUTH_BF_WINDOW_MS },
    );
  }
}

/**
 * Clear attempt counters for an IP + email pair on successful authentication.
 * Call after a successful login so a legitimate user who fat-fingered their
 * password is not punished for previous failures.
 */
export function resetAttempts(ip: string, email: string): void {
  ipBuckets.delete(ip);
  emailBuckets.delete(email.toLowerCase());
}

/** Returns summary stats for the diagnostics endpoint. */
export function getBruteForceStats() {
  return {
    trackedIps: ipBuckets.size,
    trackedAccounts: emailBuckets.size,
    maxAttempts: env.AUTH_BF_MAX_ATTEMPTS,
    windowMs: env.AUTH_BF_WINDOW_MS,
    bypassConfigured: Boolean(env.AUTH_BF_BYPASS_TOKEN),
  };
}
