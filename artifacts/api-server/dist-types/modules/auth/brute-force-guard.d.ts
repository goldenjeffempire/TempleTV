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
/**
 * Check whether the given IP or email is currently locked out.
 * Call this BEFORE the password-hash comparison so a locked-out key never
 * reaches the intentionally-slow bcrypt/argon2 work factor.
 *
 * @returns `{ blocked, retryAfterSecs, reason }` — blocked=false when allowed.
 */
export declare function checkBruteForce(ip: string, email: string, bypassToken?: string): {
    blocked: boolean;
    retryAfterSecs: number;
    reason: string;
};
/**
 * Record a failed login attempt for an IP + email pair.
 * Call this ONLY for credential errors (wrong password / unknown email), not
 * for 5xx server errors — a transient DB outage should not lock users out.
 */
export declare function recordFailedAttempt(ip: string, email: string): void;
/**
 * Clear attempt counters for an IP + email pair on successful authentication.
 * Call after a successful login so a legitimate user who fat-fingered their
 * password is not punished for previous failures.
 */
export declare function resetAttempts(ip: string, email: string): void;
/** Returns summary stats for the diagnostics endpoint. */
export declare function getBruteForceStats(): {
    trackedIps: number;
    trackedAccounts: number;
    maxAttempts: number;
    windowMs: number;
    bypassConfigured: boolean;
};
