/**
 * broadcast-scheduler — OMEGA Broadcast Automation
 *
 * Runs every 10 seconds and autonomously:
 *   1. Expires live overrides whose `endsAt` has passed.
 *   2. Auto-starts scheduled overrides whose `scheduledFor` has arrived.
 *   3. Validates broadcast engine health and triggers reload if stale.
 *   4. Emits appropriate OMEGA signals so all clients stay in sync.
 *
 * This is the "system operates itself" component of the OMEGA spec —
 * admin staff supervise, the scheduler enforces the calendar.
 */
export declare const broadcastScheduler: {
    start(): void;
    stop(): void;
    /** Validates and cleans up the scheduler on process exit. */
    shutdown(): Promise<void>;
    /** Force an immediate tick (e.g., after admin state change). */
    runNow(): Promise<void>;
};
