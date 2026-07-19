/**
 * In-memory circuit breaker for external service calls.
 *
 * Prevents cascading failures when an upstream dependency (YouTube API,
 * EAS/GitHub, webhooks) is temporarily unavailable or rate-limiting us.
 * Instead of waiting for every request to time out (10–15 s), the breaker
 * fails fast once a threshold is crossed and self-heals after a cooldown.
 *
 * States
 * ──────
 *   CLOSED     Normal operation — requests flow through.
 *   OPEN       Tripped — requests are rejected immediately (no network I/O).
 *   HALF_OPEN  Cooldown elapsed — one probe request is allowed through;
 *              success → CLOSED, failure → OPEN (resets timer).
 *
 * Usage
 * ─────
 *   import { youtubeApiCircuit, withCircuitBreaker } from "../infrastructure/circuit-breaker.js";
 *
 *   const data = await withCircuitBreaker(youtubeApiCircuit, () => fetch(url, { signal }));
 *
 *   // Optional sync-only guard (non-async call sites):
 *   if (youtubeApiCircuit.isOpen()) throw new ServiceUnavailableError("...");
 */
type CbState = "CLOSED" | "OPEN" | "HALF_OPEN";
export interface CircuitBreakerOptions {
    /** Human-readable name for logs and metrics. */
    name: string;
    /** Consecutive failures to trip. Default: 3. */
    failureThreshold?: number;
    /** Consecutive successes in HALF_OPEN to close. Default: 2. */
    successThreshold?: number;
    /** Milliseconds in OPEN before entering HALF_OPEN. Default: 60 000 (1 min). */
    halfOpenTimeoutMs?: number;
}
export interface CircuitStatus {
    name: string;
    state: CbState;
    consecutiveFailures: number;
    openedAt: number | null;
    timeUntilHalfOpenMs: number | null;
}
export declare class CircuitBreaker {
    private state;
    private consecutiveFailures;
    private consecutiveSuccesses;
    private openedAt;
    private readonly name;
    private readonly failureThreshold;
    private readonly successThreshold;
    private readonly halfOpenTimeoutMs;
    constructor(opts: CircuitBreakerOptions);
    /**
     * Returns true when the circuit is OPEN and the half-open timeout has NOT
     * yet elapsed (i.e. the call should be blocked).  Transitions OPEN →
     * HALF_OPEN automatically when the timeout elapses.
     */
    isOpen(): boolean;
    /** Call after a successful upstream response. */
    recordSuccess(): void;
    /** Call after a failed upstream response (non-2xx, timeout, network error). */
    recordFailure(): void;
    /** Manually reset the breaker (e.g. after operator intervention). */
    reset(): void;
    getStatus(): CircuitStatus;
}
/**
 * Execute `fn` with circuit-breaker protection.
 *
 * - When circuit is OPEN → throws ServiceUnavailableError (or returns fallback).
 * - On success  → records success, returns result.
 * - On failure  → records failure, rethrows.
 *
 * @param breaker   Named CircuitBreaker instance.
 * @param fn        The async call to protect.
 * @param fallback  Optional synchronous fallback to return when circuit is open
 *                  instead of throwing (useful for non-critical reads that can
 *                  return a degraded/empty result).
 */
export declare function withCircuitBreaker<T>(breaker: CircuitBreaker, fn: () => Promise<T>, opts?: {
    fallback?: () => T | Promise<T>;
}): Promise<T>;
/** YouTube Data API v3 (googleapis.com) — also protects RSS fallback indirectly. */
export declare const youtubeApiCircuit: CircuitBreaker;
/** Expo Application Services GraphQL API. */
export declare const easApiCircuit: CircuitBreaker;
/** GitHub Actions workflow-dispatch API. */
export declare const githubApiCircuit: CircuitBreaker;
/** Outbound webhook delivery calls. */
export declare const webhookDeliveryCircuit: CircuitBreaker;
/** Cross-environment prod-sync upstream poll. */
export declare const prodSyncCircuit: CircuitBreaker;
/** Returns a snapshot of every named circuit for health / diagnostics routes. */
export declare function getAllCircuitStatuses(): CircuitStatus[];
export {};
