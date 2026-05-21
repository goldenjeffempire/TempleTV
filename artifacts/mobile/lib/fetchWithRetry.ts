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
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 350;
const DEFAULT_MAX_DELAY_MS = 10_000;

/** Default retryable predicate: 5xx and 429 */
function defaultIsRetryable(res: Response): boolean {
  return res.status === 429 || res.status >= 500;
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
    const id = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
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
  const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;

  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(input, init);

      if (res.ok) return res;

      if (!isRetryable(res)) return res;

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
