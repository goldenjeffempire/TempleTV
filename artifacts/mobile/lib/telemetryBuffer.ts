/**
 * Offline-resilient telemetry buffer.
 *
 * Problem: `postPlaybackTelemetryDelta()` fire-and-forget calls silently drop
 * when the device is offline or the API is temporarily unreachable. Over a
 * long session (e.g. overnight broadcast), this can lose thousands of quality
 * signal data-points that the server uses for stall-rate dashboards.
 *
 * Solution: a module-level FIFO queue (max 120 events ≈ 2 h of heartbeats)
 * that stores telemetry events when the network is down or the flush fails.
 * When the caller reports the device is online, `flushTelemetryBuffer()` drains
 * the queue — oldest-first — in a single coordinated batch send, then clears
 * the flushed entries.
 *
 * Usage:
 *   // In V2PlayerContainer or any playback surface:
 *   enqueueTelemetry({ platform: "mobile", decoded: 1800, dropped: 0 });
 *
 *   // In NetworkContext's justRecovered effect:
 *   flushTelemetryBuffer(apiUrl);
 *
 * Design constraints:
 *   • Max 120 events (never grow without bound — drop oldest on overflow)
 *   • Flush is opportunistic: a failed flush does NOT clear the queue so
 *     events will be retried on the next online recovery event.
 *   • No AsyncStorage persistence: telemetry is best-effort quality signal,
 *     not critical business data. Losing a queue on app kill is acceptable.
 *   • Thread safety: React Native JS is single-threaded so no locks needed.
 */

export interface TelemetryEvent {
  platform: string;
  decoded:  number;
  dropped:  number;
  ts:       number;
}

const QUEUE_MAX = 120;
const queue: TelemetryEvent[] = [];

let flushInFlight = false;

/**
 * Add a telemetry event to the buffer. If the queue is full, the oldest
 * event is dropped (FIFO overflow — keeps the most recent data).
 */
export function enqueueTelemetry(event: Omit<TelemetryEvent, "ts">): void {
  if (queue.length >= QUEUE_MAX) {
    queue.shift(); // drop oldest
  }
  queue.push({ ...event, ts: Date.now() });
}

/**
 * How many events are currently buffered (useful for logging/monitoring).
 */
export function telemetryBufferSize(): number {
  return queue.length;
}

/**
 * Attempt to flush all buffered events to the server.
 *
 * Sends each event individually using the existing telemetry endpoint
 * (`/api/broadcast/playback-telemetry`) so we don't need a new batch
 * endpoint. The flush is rate-limited to 5 events/s to avoid a burst
 * against the API right after network recovery.
 *
 * If any event fails to send, the flush stops and the remaining events
 * (including the failed one) stay in the queue for the next flush cycle.
 *
 * @param apiBase  e.g. "https://api.templetv.org.ng"
 * @param platform "mobile" | "tv" | "web"
 */
export async function flushTelemetryBuffer(
  apiBase: string,
  platform = "mobile",
): Promise<void> {
  if (flushInFlight || queue.length === 0) return;
  flushInFlight = true;

  const endpoint = `${apiBase.replace(/\/$/, "")}/api/broadcast/playback-telemetry`;

  try {
    while (queue.length > 0) {
      const event = queue[0];
      if (!event) break;

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Platform": platform },
          body: JSON.stringify({
            platform: event.platform,
            decoded:  event.decoded,
            dropped:  event.dropped,
            ts:       event.ts,
          }),
          signal: AbortSignal.timeout(6_000),
        });

        if (!res.ok && res.status < 500) {
          // 4xx — server rejected this event; discard rather than retry-loop
          queue.shift();
          continue;
        }

        if (!res.ok) {
          // 5xx — transient server error; stop flush, keep event for retry
          break;
        }

        // Success — remove the event and throttle to 5 events/s
        queue.shift();
        await new Promise<void>((r) => setTimeout(r, 200));
      } catch {
        // Network error — stop flush; keep remaining events for next cycle
        break;
      }
    }
  } finally {
    flushInFlight = false;
  }
}
