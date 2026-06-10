/**
 * Generic supervised worker runtime.
 *
 * Wraps any async function with:
 *  - Automatic crash-recovery with configurable exponential backoff + jitter
 *  - Circuit breaker (suspends worker after N consecutive failures)
 *  - Per-worker health telemetry for the /diagnostics endpoint
 *  - Structured logging at every state transition
 *
 * Usage:
 *   workerSupervisor.spawn({
 *     name: "media-scanner",
 *     intervalMs: 120_000,
 *     fn: () => mediaIntegrityScanner.scan(),
 *   });
 */
import { logger } from "../../../infrastructure/logger.js";

export interface WorkerConfig {
  name: string;
  fn: () => Promise<unknown>;
  intervalMs?: number;
  backoffMs?: readonly number[];
  maxConsecutiveFailures?: number;
  initialDelayMs?: number;
  /**
   * Called once, synchronously, the moment the circuit breaker opens.
   * Use this to fire SSE ops-alerts or out-of-band email from the caller
   * without creating an import cycle between worker-supervisor and the
   * notification layer.
   *
   * Must never throw — WorkerSupervisor wraps the call in try/catch.
   */
  onCircuitOpen?: (name: string, consecutiveFailures: number) => void;
}

export interface WorkerHealth {
  name: string;
  running: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  totalRuns: number;
  totalErrors: number;
  lastRunAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
  nextRunAtMs: number | null;
  /** Wall-clock ms when the circuit breaker will auto-reset. Null when closed. */
  circuitAutoResetAtMs: number | null;
}

const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000] as const;
/**
 * After a circuit-breaker trip, automatically reset and retry the worker
 * after this many milliseconds (10 minutes). Prevents transient errors from
 * permanently silencing background workers without operator intervention.
 */
const CIRCUIT_AUTO_RESET_MS = 10 * 60_000;

class SupervisedWorker {
  private running = false;
  private circuitOpen = false;
  private consecutiveFailures = 0;
  private totalRuns = 0;
  private totalErrors = 0;
  private lastRunAtMs: number | null = null;
  private lastSuccessAtMs: number | null = null;
  private lastErrorAtMs: number | null = null;
  private lastError: string | null = null;
  private nextRunAtMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Scheduled auto-reset timer after a circuit-breaker trip. */
  private circuitResetTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: WorkerConfig) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.cfg.initialDelayMs ?? 0);
    logger.info(
      { worker: this.cfg.name, intervalMs: this.cfg.intervalMs ?? null, initialDelayMs: this.cfg.initialDelayMs ?? 0 },
      "[worker-supervisor] worker started",
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.circuitResetTimer) {
      clearTimeout(this.circuitResetTimer);
      this.circuitResetTimer = null;
    }
    logger.info({ worker: this.cfg.name }, "[worker-supervisor] worker stopped");
  }

  resetCircuit(): void {
    if (this.circuitResetTimer) {
      clearTimeout(this.circuitResetTimer);
      this.circuitResetTimer = null;
    }
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
    if (this.running) this.schedule(0);
    logger.info({ worker: this.cfg.name }, "[worker-supervisor] circuit breaker reset");
  }

  health(): WorkerHealth {
    return {
      name: this.cfg.name,
      running: this.running,
      circuitOpen: this.circuitOpen,
      consecutiveFailures: this.consecutiveFailures,
      totalRuns: this.totalRuns,
      totalErrors: this.totalErrors,
      lastRunAtMs: this.lastRunAtMs,
      lastSuccessAtMs: this.lastSuccessAtMs,
      lastErrorAtMs: this.lastErrorAtMs,
      lastError: this.lastError,
      nextRunAtMs: this.nextRunAtMs,
      circuitAutoResetAtMs: this.circuitResetTimer !== null
        ? (this.lastErrorAtMs ?? Date.now()) + CIRCUIT_AUTO_RESET_MS
        : null,
    };
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.circuitOpen) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Add ±10% jitter to stagger workers that share the same interval and
    // prevent a thundering-herd of DB reads on process restart.
    const jitter = delayMs > 1_000 ? Math.floor(Math.random() * delayMs * 0.1) : 0;
    const actual = delayMs + jitter;
    this.nextRunAtMs = Date.now() + actual;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRunAtMs = null;
      void this.execute();
    }, actual);
    this.timer.unref?.();
  }

  private async execute(): Promise<void> {
    if (!this.running || this.circuitOpen) return;
    this.lastRunAtMs = Date.now();
    this.totalRuns += 1;
    try {
      await this.cfg.fn();
      this.consecutiveFailures = 0;
      this.lastSuccessAtMs = Date.now();
      if (this.cfg.intervalMs) this.schedule(this.cfg.intervalMs);
    } catch (err) {
      this.consecutiveFailures += 1;
      this.totalErrors += 1;
      this.lastErrorAtMs = Date.now();
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { worker: this.cfg.name, consecutiveFailures: this.consecutiveFailures, err },
        "[worker-supervisor] worker run failed",
      );
      const max = this.cfg.maxConsecutiveFailures ?? Infinity;
      if (this.consecutiveFailures >= max) {
        this.circuitOpen = true;
        logger.error(
          { worker: this.cfg.name, consecutiveFailures: this.consecutiveFailures, maxAllowed: max, autoResetMs: CIRCUIT_AUTO_RESET_MS },
          "[worker-supervisor] circuit breaker opened — worker suspended; auto-reset scheduled",
        );
        // Notify the caller so it can push an out-of-band alert (SSE ops-alert,
        // email) without creating an import cycle between this module and the
        // notification layer. Wrapped in try/catch so a throwing callback never
        // crashes the supervisor itself.
        if (this.cfg.onCircuitOpen) {
          try {
            this.cfg.onCircuitOpen(this.cfg.name, this.consecutiveFailures);
          } catch (cbErr) {
            logger.warn({ worker: this.cfg.name, err: cbErr }, "[worker-supervisor] onCircuitOpen callback threw (non-fatal)");
          }
        }
        // Auto-reset after cooldown so transient errors (DB blip, network
        // hiccup, cold-start race) don't permanently silence background
        // workers. The timer is cancelled if stop() or resetCircuit() is
        // called first.
        if (this.circuitResetTimer) clearTimeout(this.circuitResetTimer);
        this.circuitResetTimer = setTimeout(() => {
          this.circuitResetTimer = null;
          if (this.circuitOpen) {
            logger.info(
              { worker: this.cfg.name, cooldownMs: CIRCUIT_AUTO_RESET_MS },
              "[worker-supervisor] circuit auto-reset after cooldown — retrying worker",
            );
            this.resetCircuit();
          }
        }, CIRCUIT_AUTO_RESET_MS);
        this.circuitResetTimer.unref?.();
        return;
      }
      const backoff = this.cfg.backoffMs ?? DEFAULT_BACKOFF_MS;
      const delay = backoff[Math.min(this.consecutiveFailures - 1, backoff.length - 1)]!;
      this.schedule(delay);
    }
  }
}

export class WorkerSupervisor {
  private readonly workers = new Map<string, SupervisedWorker>();

  spawn(cfg: WorkerConfig): SupervisedWorker {
    const existing = this.workers.get(cfg.name);
    if (existing) {
      if (!existing.health().running) existing.start();
      return existing;
    }
    const w = new SupervisedWorker(cfg);
    this.workers.set(cfg.name, w);
    w.start();
    return w;
  }

  get(name: string): SupervisedWorker | undefined {
    return this.workers.get(name);
  }

  getHealth(): WorkerHealth[] {
    return Array.from(this.workers.values()).map((w) => w.health());
  }

  /**
   * Stop and remove a single named worker.  Safe to call if the worker does
   * not exist — returns false in that case, true if it was found and removed.
   *
   * Use this when workers are spawned dynamically (e.g. per-channel) and the
   * channel is torn down — without remove() the workers Map grows indefinitely.
   */
  remove(name: string): boolean {
    const w = this.workers.get(name);
    if (!w) return false;
    w.stop();
    this.workers.delete(name);
    return true;
  }

  stopAll(): void {
    for (const w of this.workers.values()) w.stop();
    this.workers.clear();
  }
}

export const workerSupervisor = new WorkerSupervisor();
