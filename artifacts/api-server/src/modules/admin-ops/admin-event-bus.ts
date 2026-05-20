import { EventEmitter } from "node:events";

/**
 * In-process event bus for admin-targeted SSE events.
 *
 * Any server module that needs to push a real-time notification to all
 * connected admin SPA clients imports `adminEventBus` and calls `.emit()`
 * with an event name and a JSON-serialisable payload.
 *
 * The admin SSE endpoint (`/admin/live/events`) subscribes each connection
 * to this bus alongside the broadcast-engine bus, so events flow to the
 * browser without polling.
 *
 * Intentionally separate from `broadcastEngine` (which carries public
 * broadcast-queue snapshots visible to TV/mobile viewers) — this bus is
 * for privileged admin-only signals.
 */
class AdminEventBus extends EventEmitter {
  /**
   * Emit a typed admin event.  `data` must be JSON-serialisable.
   */
  push(type: string, data: unknown): void {
    this.emit("admin-event", { type, data });
  }
}

export const adminEventBus = new AdminEventBus();

// Node's default max-listener ceiling is 10.  Each open admin SSE
// connection adds one listener; raise the ceiling so a busy ops team
// with many browser tabs doesn't trigger the spurious warning.
adminEventBus.setMaxListeners(200);
