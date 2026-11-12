/**
 * Advisory viewer telemetry, never the server's sequencing clock.
 * Observer sessions must not mutate station state even when their local video
 * ends, errors, loses its connection, or is detached during logout/navigation.
 */
export function createNaturalEndNotifier(options: {
  baseUrl: string;
  observer: boolean;
  isActive: () => boolean;
  getAuthToken: () => string | null | undefined;
  requestSnapshot: () => void;
  fetcher?: typeof fetch;
  schedule?: (callback: () => void, delay: number) => unknown;
}): (itemId: string) => void {
  const fetcher = options.fetcher ?? fetch;
  const schedule = options.schedule ?? ((fn, delay) => {
    const timer = setTimeout(fn, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  });
  return itemId => {
    if (options.observer || !options.isActive()) return;
    const delays = [300, 800, 2_000];
    const post = (attempt: number) => {
      if (options.observer || !options.isActive()) return;
      const token = options.getAuthToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      void fetcher(`${options.baseUrl}/natural-end`, {
        method: "POST", headers, body: JSON.stringify({ itemId }),
        signal: AbortSignal.timeout(8_000),
      }).then(response => {
        if (!response.ok) throw new Error(`Natural-end signal returned ${response.status}`);
      }).catch(() => {
        if (!options.isActive()) return;
        const delay = delays[attempt];
        if (delay !== undefined) schedule(() => post(attempt + 1), delay);
        else options.requestSnapshot();
      });
    };
    post(0);
  };
}
