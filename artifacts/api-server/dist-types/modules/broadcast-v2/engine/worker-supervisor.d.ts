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
    stopAll(): void;
}
export declare const workerSupervisor: WorkerSupervisor;
export {};
