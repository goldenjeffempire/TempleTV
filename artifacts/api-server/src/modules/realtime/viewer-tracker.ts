/**
 * Viewer Tracker — shared module for counting active broadcast viewers.
 *
 * Two independent real-time gateways serve viewers:
 *   • /realtime/ws       → WebSocket (TV, mobile native, admin)
 *   • /broadcast/events  → SSE (mobile React Native, web tabs)
 *
 * Both increment / decrement their own counter here; the tracker sums
 * them and pushes the combined total into `broadcastEngine.setViewerCount()`
 * on every change. This ensures the "viewer-count" event emitted to all
 * clients reflects ALL connected viewers — not just WebSocket ones.
 *
 * Thread safety: Node.js is single-threaded so no locking needed.
 */

import { broadcastEngine } from "../broadcast/queue.engine.js";

let wsCount = 0;
let sseCount = 0;

function push(): void {
  broadcastEngine.setViewerCount(wsCount + sseCount);
}

export function bumpWsViewers(delta: 1 | -1): void {
  wsCount = Math.max(0, wsCount + delta);
  push();
}

export function bumpSseViewers(delta: 1 | -1): void {
  sseCount = Math.max(0, sseCount + delta);
  push();
}

export function getViewerCounts(): { ws: number; sse: number; total: number } {
  return { ws: wsCount, sse: sseCount, total: wsCount + sseCount };
}
