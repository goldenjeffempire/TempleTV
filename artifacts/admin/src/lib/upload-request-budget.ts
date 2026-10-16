/** Bound bulk work across every file, leaving HTTP/1.1 connections for control traffic. */
export class UploadRequestBudget {
  private active = 0;
  private waiting: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: DOMException) => void;
    onAbort: () => void;
  }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid upload budget");
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");
      return await work();
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DOMException("Upload aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const waiter = {
        signal, resolve, reject,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(new DOMException("Upload aborted", "AbortError"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new DOMException("Upload aborted", "AbortError"));
        continue;
      }
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}

// Per-tab limits, not per-file limits. Acquire BEFORE allocating chunk buffers.
// Leave room for the admin stream, broadcast stream, AND an ordinary request
// even when a browser/proxy falls back to six HTTP/1.1 connections per origin.
export const chunkUploadBudget = new UploadRequestBudget(3);
export const fileHashBudget = new UploadRequestBudget(1);
