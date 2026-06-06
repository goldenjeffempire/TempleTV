/**
 * Shared shutdown-state singleton.
 *
 * A dedicated module is needed (rather than exporting directly from main.ts)
 * to avoid circular-import chains:
 *   health.routes → app → … → main  (would cycle back to main.ts)
 *
 * Usage:
 *   main.ts      → markShuttingDown() on SIGTERM/SIGINT
 *   health.routes → isShuttingDown() in liveness handler → HTTP 503
 *
 * The 503 tells upstream load balancers (Render, AWS ALB, k8s, Replit proxy)
 * to drain traffic and stop routing new requests before connections are
 * forcibly closed — the key mechanism for zero-downtime rolling restarts.
 */

let _shuttingDown = false;

/** Returns true once SIGTERM or SIGINT has been received. */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/**
 * Called once by main.ts on SIGTERM/SIGINT, before any services are stopped.
 * After this point every liveness probe returns HTTP 503 so the upstream LB
 * has time to observe the failure and drain in-flight requests.
 */
export function markShuttingDown(): void {
  _shuttingDown = true;
}
