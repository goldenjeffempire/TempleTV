/** One OS subscription and one initial read for all mounted cards/buttons. */
export function createReducedMotionStore(io: {
  read(): Promise<boolean>;
  watch(update: (reduced: boolean) => void): () => void;
}) {
  let reduced = true; // Conservative until the OS preference is known.
  let generation = 0;
  let stop: (() => void) | null = null;
  const subscribers = new Set<() => void>();
  function subscribe(listener: () => void) {
    subscribers.add(listener);
    if (subscribers.size === 1) {
      const current = ++generation;
      let eventSeen = false;
      const update = (value: boolean) => {
        if (current !== generation || reduced === value) return;
        reduced = value;
        for (const subscriber of [...subscribers]) subscriber();
      };
      stop = io.watch(value => { eventSeen = true; update(value); });
      void io.read().then(value => { if (!eventSeen) update(value); }).catch(() => {});
    }
    return () => {
      subscribers.delete(listener);
      if (subscribers.size === 0) { generation++; stop?.(); stop = null; }
    };
  }
  return { subscribe, getSnapshot: () => reduced };
}
