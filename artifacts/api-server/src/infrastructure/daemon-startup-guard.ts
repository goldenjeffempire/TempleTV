/** Bound I/O independently of pg's server-side timeout (poolers can stall too). */
export async function withDaemonDeadline<T>(
  operation: Promise<T>, label: string, timeoutMs = 6_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Daemon operation timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A health socket must not leave a stalled startup apparently Live forever. */
export function createDaemonStartupGuard(
  onTimeout: (phase: string) => void, timeoutMs = 180_000,
) {
  let phase = "schema-bootstrap";
  let finished = false;
  const timer = setTimeout(() => {
    if (!finished) onTimeout(phase);
  }, timeoutMs);
  timer.unref?.();
  return {
    phase: () => phase,
    enter(next: string) { phase = next; },
    complete() {
      finished = true;
      phase = "ready";
      clearTimeout(timer);
    },
  };
}
