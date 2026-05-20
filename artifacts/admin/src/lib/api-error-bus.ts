export interface ApiErrorEvent {
  path: string;
  status: number;
  message: string;
  ts: number;
}

type Handler = (ev: ApiErrorEvent) => void;

const _handlers = new Set<Handler>();

export const apiErrorBus = {
  emit(ev: ApiErrorEvent): void {
    _handlers.forEach((h) => {
      try { h(ev); } catch { /* never let a handler crash the request path */ }
    });
  },
  subscribe(h: Handler): () => void {
    _handlers.add(h);
    return () => { _handlers.delete(h); };
  },
};
