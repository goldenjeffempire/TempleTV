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
}

const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000] as const;

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
    logger.info({ worker: this.cfg.name }, "[worker-supervisor] worker stopped");
  }

  resetCircuit(): void {
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
          { worker: this.cfg.name, consecutiveFailures: this.consecutiveFailures, maxAllowed: max },
          "[worker-supervisor] circuit breaker opened — worker suspended until resetCircuit()",
        );
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

  stopAll(): void {
    for (const w of this.workers.values()) w.stop();
    this.workers.clear();
  }
}

export const workerSupervisor = new WorkerSupervisor();
