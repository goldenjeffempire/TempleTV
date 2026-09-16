/**
 * fetchWithRetry — resilient fetch for poor mobile connections.
 *
 * Retries automatically on transient failures:
 *   • Network errors (TypeError: "Failed to fetch", connection resets, etc.)
 *   • 5xx server errors (transient server-side issues)
 *   • 429 Too Many Requests (honours the Retry-After response header)
 *
 * Never retries:
 *   • 4xx client errors (except 429) — these are intentional server rejections
 *   • AbortSignal cancellations — propagates immediately
 *   • Successful responses (2xx / 3xx)
 *
 * Backoff: full jitter exponential — each delay is random in [0, min(base*2^n, cap)].
 * Full jitter is preferred over equal/decorrelated jitter for mobile because it
 * spreads reconnection storms across an entire interval rather than clustering
 * retries near the midpoint (see "Exponential Backoff And Jitter", AWS Architecture Blog).
 *
 * Usage:
 *   const res = await fetchWithRetry("/api/videos", init);
 *   const res = await fetchWithRetry(url, init, { maxRetries: 2, baseDelayMs: 500 });
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the initial attempt). Default: 3 */
  maxRetries?: number;
  /** Base delay in ms before the first retry. Doubles each attempt. Default: 350 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (before jitter). Default: 10_000 */
  maxDelayMs?: number;
  /**
   * Custom predicate that decides whether a failed Response is retryable.
   * Called only for non-ok responses; returning true triggers a retry.
   * Defaults to: retry on 5xx and 429.
   */
  isRetryable?: (res: Response) => boolean;
  /** Per-attempt timeout in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
// 1 s base gives the mobile radio (LTE handoff, cell tower switch) time to
// complete its state transition before the first retry fires. The old 350 ms
// value was so short that the first retry almost always hit the radio mid-
// recovery, causing a second failure and burning an extra retry slot.
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 10_000;

/**
 * Per-attempt fetch timeout applied when the caller does not provide an
 * AbortSignal. On mobile, zombie TCP connections (OS keep-alive open, no
 * application-layer traffic) can cause `fetch()` to hang indefinitely.
 * 15 s gives enough headroom for a legitimate slow CDN response while still
 * tearing down true zombies within one watchdog cycle.
 * Callers that pass their own signal always take precedence — this only
 * activates as a safety net when no signal is provided.
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Default retryable predicate: 5xx, 429, and 408.
 * 408 (Request Timeout) is common on mobile "zombie" connections — the
 * carrier's NAT/proxy times out the TCP connection after a period of
 * inactivity, causing the next request to silently hang until the OS
 * eventually surfaces a 408. These are always transient and safe to retry.
 */
function defaultIsRetryable(res: Response): boolean {
  return res.status === 408 || res.status === 429 || res.status >= 500;
}

/**
 * Full-jitter exponential backoff: random value in [0, min(base * 2^attempt, cap)].
 * Returns milliseconds to wait before the next attempt.
 */
function jitteredBackoff(attempt: number, baseMs: number, capMs: number): number {
  const ceiling = Math.min(baseMs * Math.pow(2, attempt), capMs);
  return Math.random() * ceiling;
}

/**
 * Delay for `ms` milliseconds, cancelling immediately if `signal` is aborted.
 * Throws a DOMException("AbortError") on cancellation so callers can distinguish
 * user-initiated aborts from retry-exhaustion failures.
 */
function delayWithSignal(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    // Hoisted so the setTimeout callback can reference it for removeEventListener
    // cleanup. Declared before setTimeout to keep it in scope for the async
    // callback even though the assignment happens in the if(signal) block below.
    let onAbort: (() => void) | undefined;
    const id = setTimeout(() => {
      // Remove the abort listener before resolving so it doesn't linger on
      // the signal (e.g. AbortSignal.timeout()) until the signal fires ~15 s
      // later, keeping the closure and its captured `id`/`reject` alive well
      // past the point where they are useful.
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(id);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Parse the Retry-After header value (seconds or HTTP-date) into milliseconds.
 * Returns null if the header is absent or unparseable.
 */
function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (!raw) return null;
  const seconds = parseInt(raw, 10);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryable = options?.isRetryable ?? defaultIsRetryable;
  const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const signal = init?.signal;

  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Apply a fresh per-attempt timeout, including when the caller supplied
      // a signal. The caller signal is relayed separately so it can still
      // cancel the complete retry operation.
      // On mobile, zombie TCP connections (OS keep-alive open, application layer
      // silent) can cause fetch() to hang indefinitely. AbortSignal.timeout()
      // tears the connection down so the retry loop can issue a fresh attempt.
      // Callers that pass their own signal always take precedence.
      // A timeout fires as DOMException("TimeoutError") which is neither
      // signal?.aborted nor "AbortError", so it falls through to the retry
      // path below — correct: a timed-out attempt should be retried.
      // Always use a fresh controller per attempt.  A timeout controller must
      // not be shared with the retry loop, otherwise the first timed-out
      // attempt leaves the signal permanently aborted and all retries fail
      // immediately.  Relay the caller's signal separately so user
      // cancellation still aborts the whole operation.
      const attemptController = new AbortController();
      const onCallerAbort = () => attemptController.abort(signal?.reason);
      if (signal) {
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const timeoutId = setTimeout(() => {
        attemptController.abort(new DOMException("Timeout", "TimeoutError"));
      }, timeoutMs);
      try {
        const res = await fetch(input, { ...init, signal: attemptController.signal });

        if (res.ok) return res;

        if (!isRetryable(res)) {
        // In dev, surface the non-OK status immediately so engineers see the
        // problem rather than chasing a silent null return in a service layer.
        if (__DEV__) {
          console.warn(
            `[fetchWithRetry] Non-retryable ${res.status} from ${typeof input === "string" ? input : String(input)}`,
          );
        }
          return res;
        }

        if (attempt >= maxRetries) return res;

      // 429: honour Retry-After if present, otherwise use normal backoff
      let delayMs: number;
      if (res.status === 429) {
        delayMs = parseRetryAfterMs(res.headers) ?? jitteredBackoff(attempt, baseDelayMs, maxDelayMs);
      } else {
        delayMs = jitteredBackoff(attempt, baseDelayMs, maxDelayMs);
      }

        await delayWithSignal(delayMs, signal);
        attempt++;
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onCallerAbort);
      }
    } catch (err) {
      // Re-throw immediately on abort — never retry a cancelled request
      if (signal?.aborted) throw err;
      // Also re-throw if this was a DOMException AbortError from our delay
      if (err instanceof DOMException && err.name === "AbortError") throw err;

      // Network error (TypeError: "Failed to fetch", "Network request failed", etc.)
      // These are always transient on mobile — retry with backoff.
      if (attempt >= maxRetries) throw err;

      await delayWithSignal(
        jitteredBackoff(attempt, baseDelayMs, maxDelayMs),
        signal,
      );
      attempt++;
    }
  }
}
