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
declare class SupervisedWorker {
    private readonly cfg;
    private running;
    private circuitOpen;
    private consecutiveFailures;
    private totalRuns;
    private totalErrors;
    private lastRunAtMs;
    private lastSuccessAtMs;
    private lastErrorAtMs;
    private lastError;
    private nextRunAtMs;
    private timer;
    /** Scheduled auto-reset timer after a circuit-breaker trip. */
    private circuitResetTimer;
    constructor(cfg: WorkerConfig);
    start(): void;
    stop(): void;
    resetCircuit(): void;
    health(): WorkerHealth;
    private schedule;
    private execute;
}
export declare class WorkerSupervisor {
    private readonly workers;
    spawn(cfg: WorkerConfig): SupervisedWorker;
    get(name: string): SupervisedWorker | undefined;
    getHealth(): WorkerHealth[];
    /**
     * Stop and remove a single named worker.  Safe to call if the worker does
     * not exist — returns false in that case, true if it was found and removed.
     *
     * Use this when workers are spawned dynamically (e.g. per-channel) and the
     * channel is torn down — without remove() the workers Map grows indefinitely.
     */
    remove(name: string): boolean;
    stopAll(): void;
}
export declare const workerSupervisor: WorkerSupervisor;
export {};
