/**
 * Process lifecycle state — single source of truth for "is this instance
 * willing to accept new traffic right now?".
 *
 * Why this exists
 * ───────────────
 * The default `/healthz` returned `{status:"ok"}` unconditionally, so a
 * platform load balancer (Render, Replit deployments, k8s) had no way to
 * know when this instance was:
 *
 *   - still booting (schedulers not yet armed, S3 reconciler still walking),
 *   - actively draining due to SIGTERM (rolling deploy, scale-in),
 *   - or running but with a degraded dependency (DB connection lost).
 *
 * Without a draining state, every restart triggered the "API connection
 * lost · reconnecting (attempt N)" toast in the admin (observed at
 * 2026-04-26T08:00Z) because the LB kept routing traffic to the dying
 * instance until TCP closed mid-request, instead of seeing a 503 first
 * and routing elsewhere.
 *
 * Usage
 * ─────
 *   - `markReady()` is called once after schedulers arm so /healthz can
 *     report `starting` until then.
 *   - `markDraining()` is called from the SIGTERM/SIGINT handler before
 *     `server.close()` so /healthz immediately starts returning 503 and
 *     the LB stops routing new requests while in-flight ones drain.
 *   - `getLifecycleState()` is read by /healthz on every request.
 *
 * The state is process-local (not shared across instances) — that's the
 * right scope: each instance answers for itself, and the LB aggregates.
 */

export type LifecyclePhase = "starting" | "ready" | "draining";

let phase: LifecyclePhase = "starting";
let readyAt: Date | null = null;
let drainingAt: Date | null = null;
const startedAt = new Date();

export function markReady(): void {
  if (phase === "draining") return; // SIGTERM beat us to it; never go back to ready.
  phase = "ready";
  readyAt = new Date();
}

export function markDraining(): void {
  if (phase === "draining") return;
  phase = "draining";
  drainingAt = new Date();
}

export function isReady(): boolean {
  return phase === "ready";
}

export function isDraining(): boolean {
  return phase === "draining";
}

export interface LifecycleState {
  phase: LifecyclePhase;
  startedAt: string;
  readyAt: string | null;
  drainingAt: string | null;
  uptimeSec: number;
}

export function getLifecycleState(): LifecycleState {
  return {
    phase,
    startedAt: startedAt.toISOString(),
    readyAt: readyAt?.toISOString() ?? null,
    drainingAt: drainingAt?.toISOString() ?? null,
    uptimeSec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
  };
}
