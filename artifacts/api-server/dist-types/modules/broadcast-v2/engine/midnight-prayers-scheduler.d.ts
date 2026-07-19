/**
 * Midnight Prayers Scheduler
 *
 * Server-driven replacement for the old client-side "shadow engine" that
 * polled `/api/midnight-prayers/config` and swapped its base API URL between
 * `/api/broadcast-v2` and `/api/midnight-prayers`. That approach bypassed the
 * orchestrator entirely, was not integrated with the dual-buffer gapless
 * preload system, and was the root cause of blank screens / reloads at the
 * window boundary.
 *
 * This scheduler instead drives the orchestrator's queue-swap engine
 * (`activateMidnightPrayers` / `deactivateMidnightPrayers`): while the
 * configured window is open, the orchestrator's `this.items` IS the
 * Midnight Prayers rotation, so every viewer gets the exact same
 * dual-buffer preload, checkpoint/resume, self-healing, and dead-air
 * protection the primary broadcast already relies on — no bespoke logic.
 *
 * Polled frequently (every 10 s) so the window boundary is hit within a few
 * seconds in either direction, and so a just-uploaded/just-fixed video can
 * join an already-open window promptly.
 */
/**
 * Single scan tick: reconciles the orchestrator's Midnight Prayers state
 * with the configured window. Called every 10 s by the supervised worker.
 */
export declare function midnightPrayersSchedulerScan(): Promise<void>;
