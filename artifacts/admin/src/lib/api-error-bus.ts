export interface ApiErrorEvent {
  path: string;
  status: number;
  message: string;
  ts: number;
  /**
   * True when the response carried a structured JSON error body (Fastify
   * ProblemDetails: detail/message/error/code). A 5xx WITHOUT this flag almost
   * always originates from infrastructure (a dev Vite proxy or a production
   * reverse proxy returning an HTML/empty body when the upstream API is
   * momentarily restarting) rather than from the application itself. Consumers
   * use it to treat unstructured 5xx as transient instead of a hard error.
   */
  structured?: boolean;
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
