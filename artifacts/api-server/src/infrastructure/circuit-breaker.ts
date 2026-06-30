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

import { logger } from "./logger.js";
import { ServiceUnavailableError } from "../shared/errors.js";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Core class ────────────────────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CbState = "CLOSED";
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly halfOpenTimeoutMs: number;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.successThreshold = opts.successThreshold ?? 2;
    this.halfOpenTimeoutMs = opts.halfOpenTimeoutMs ?? 60_000;
  }

  /**
   * Returns true when the circuit is OPEN and the half-open timeout has NOT
   * yet elapsed (i.e. the call should be blocked).  Transitions OPEN →
   * HALF_OPEN automatically when the timeout elapses.
   */
  isOpen(): boolean {
    if (this.state === "CLOSED" || this.state === "HALF_OPEN") return false;
    if (Date.now() - this.openedAt >= this.halfOpenTimeoutMs) {
      this.state = "HALF_OPEN";
      this.consecutiveSuccesses = 0;
      logger.info({ circuit: this.name }, "[circuit-breaker] HALF_OPEN — probing upstream");
      return false;
    }
    return true;
  }

  /** Call after a successful upstream response. */
  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        logger.info(
          { circuit: this.name, successStreak: this.consecutiveSuccesses },
          "[circuit-breaker] CLOSED — upstream recovered",
        );
        this.state = "CLOSED";
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.openedAt = 0;
      }
    } else {
      // CLOSED — reset failure counter on success
      this.consecutiveFailures = 0;
    }
  }

  /** Call after a failed upstream response (non-2xx, timeout, network error). */
  recordFailure(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    if (this.state === "HALF_OPEN") {
      // Probe failed — back to OPEN
      this.state = "OPEN";
      this.openedAt = Date.now();
      logger.warn(
        { circuit: this.name, failures: this.consecutiveFailures },
        "[circuit-breaker] OPEN — probe failed; resetting cooldown",
      );
      return;
    }

    if (this.state === "CLOSED" && this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      logger.error(
        {
          circuit: this.name,
          failureThreshold: this.failureThreshold,
          failures: this.consecutiveFailures,
          halfOpenMs: this.halfOpenTimeoutMs,
        },
        "[circuit-breaker] OPEN — failure threshold reached; blocking upstream calls",
      );
    }
  }

  /** Manually reset the breaker (e.g. after operator intervention). */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = 0;
    logger.info({ circuit: this.name }, "[circuit-breaker] manually RESET to CLOSED");
  }

  getStatus(): CircuitStatus {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.state !== "CLOSED" ? this.openedAt : null,
      timeUntilHalfOpenMs:
        this.state === "OPEN"
          ? Math.max(0, this.halfOpenTimeoutMs - (Date.now() - this.openedAt))
          : null,
    };
  }
}

// ── Helper: wrap an async call with circuit-breaker protection ─────────────

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
export async function withCircuitBreaker<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
  opts?: { fallback?: () => T | Promise<T> },
): Promise<T> {
  if (breaker.isOpen()) {
    const status = breaker.getStatus();
    logger.warn(
      { circuit: status.name, timeUntilHalfOpenMs: status.timeUntilHalfOpenMs },
      "[circuit-breaker] request blocked — circuit OPEN",
    );
    if (opts?.fallback !== undefined) {
      return opts.fallback();
    }
    throw new ServiceUnavailableError(
      `${status.name} is temporarily unavailable — will retry in ${Math.ceil((status.timeUntilHalfOpenMs ?? 0) / 1000)} s`,
    );
  }

  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }
}

// ── Named singleton instances ─────────────────────────────────────────────────
//
// One instance per external dependency.  Centralised here so every caller
// (routes, services, workers) shares the same state counter.

/** YouTube Data API v3 (googleapis.com) — also protects RSS fallback indirectly. */
export const youtubeApiCircuit = new CircuitBreaker({
  name: "youtube-api",
  failureThreshold: 3,
  successThreshold: 2,
  halfOpenTimeoutMs: 5 * 60_000, // 5 min cooldown
});

/** Expo Application Services GraphQL API. */
export const easApiCircuit = new CircuitBreaker({
  name: "eas-api",
  failureThreshold: 3,
  successThreshold: 1,
  halfOpenTimeoutMs: 2 * 60_000,
});

/** GitHub Actions workflow-dispatch API. */
export const githubApiCircuit = new CircuitBreaker({
  name: "github-api",
  failureThreshold: 3,
  successThreshold: 1,
  halfOpenTimeoutMs: 2 * 60_000,
});

/** Outbound webhook delivery calls. */
export const webhookDeliveryCircuit = new CircuitBreaker({
  name: "webhook-delivery",
  failureThreshold: 5,
  successThreshold: 2,
  halfOpenTimeoutMs: 60_000,
});

/** Cross-environment prod-sync upstream poll. */
export const prodSyncCircuit = new CircuitBreaker({
  name: "prod-sync",
  failureThreshold: 5,
  successThreshold: 2,
  halfOpenTimeoutMs: 2 * 60_000,
});

/** Returns a snapshot of every named circuit for health / diagnostics routes. */
export function getAllCircuitStatuses(): CircuitStatus[] {
  return [
    youtubeApiCircuit.getStatus(),
    easApiCircuit.getStatus(),
    githubApiCircuit.getStatus(),
    webhookDeliveryCircuit.getStatus(),
    prodSyncCircuit.getStatus(),
  ];
}
