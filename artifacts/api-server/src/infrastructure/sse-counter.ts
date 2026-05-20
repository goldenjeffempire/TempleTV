/**
 * Process-wide counter of currently open SSE connections.
 *
 * Every SSE route (broadcast events, realtime SSE, admin live/events) calls
 * inc() when a connection is accepted and dec() when the socket closes.
 * main.ts reads get() during graceful shutdown to wait for connections to
 * drain before calling app.close(), preventing in-flight SSE frames from
 * being truncated mid-stream (F20).
 */
let _count = 0;

export const sseCounter = {
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
