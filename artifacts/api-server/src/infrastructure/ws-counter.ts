/**
 * Process-wide counter of currently open WebSocket connections.
 *
 * Mirrors the shape of sse-counter.ts so admin-ops can expose both SSE and
 * WS counts separately. Wired in broadcast-v2/io/ws.gateway.ts alongside the
 * prom-client Gauge (which tracks the same value with label dimensions for
 * Prometheus scraping).
 */
let _count = 0;

export const wsCounter = {
  inc(): void {
    _count++;
  },
  dec(): void {
    if (_count > 0) _count--;
  },
  get(): number {
    return _count;
  },
};
