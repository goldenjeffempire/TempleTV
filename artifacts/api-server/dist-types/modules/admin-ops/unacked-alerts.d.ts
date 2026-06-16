/**
 * Unacknowledged-alert escalation store.
 *
 * Listens to the admin SSE event bus for `ops-alert` events and records them
 * in an in-memory store.  A periodic sweeper escalates any alert that has
 * been pending (un-cleared) for more than ESCALATION_DELAY_MS (10 min) by
 * sending an email to the configured admin address.
 *
 * The GET /admin/ops-alerts/unacked endpoint allows the admin SPA to display
 * pending alerts and acknowledge (clear) them — after which the email is no
 * longer sent for that alert.
 *
 * Design notes:
 *  • In-memory only: intentionally ephemeral.  On restart the slate is clean.
 *    This avoids a DB migration and is acceptable because the ops dashboard
 *    is real-time and server restarts clear the alert condition anyway.
 *  • Email cooldown (5 min) prevents alert storms from flooding the inbox.
 *  • stopUnackedAlertSweeper() is called on graceful shutdown.
 */
export interface UnackedAlert {
    id: string;
    level: string;
    message: string;
    receivedAtMs: number;
    emailedAtMs: number | null;
    /**
     * True when at least one admin SSE client was connected at the moment the
     * alert was pushed (i.e. the alert appeared on a live dashboard in real
     * time).  Delivered alerts are still kept in the store for manual review,
     * but the sweeper will NOT escalate them to email — the operator already
     * saw it.  Only undelivered alerts (no SSE client was connected) are
     * escalated, because those could have been silently missed.
     */
    delivered: boolean;
}
export declare function startUnackedAlertSweeper(): void;
export declare function stopUnackedAlertSweeper(): void;
export declare function acknowledgeAlert(id: string): boolean;
export declare function acknowledgeAll(): void;
export declare function getUnackedAlerts(): UnackedAlert[];
