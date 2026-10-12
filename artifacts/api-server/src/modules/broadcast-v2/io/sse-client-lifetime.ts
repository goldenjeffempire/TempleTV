import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { FastifyReply } from "fastify";

/** Hijacking skips Fastify's header flush, including its approved CORS headers. */
export function writeSseHeaders(reply: FastifyReply, streamHeaders: OutgoingHttpHeaders): void {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    headers[name] = typeof value === "number" ? String(value) : value;
  }
  Object.assign(headers, streamHeaders);
  delete headers["content-length"];
  reply.hijack();
  reply.raw.writeHead(200, headers);
}

/** IncomingMessage.close means the GET request finished, not the SSE client left. */
export function bindSseClientLifetime(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once("aborted", abort);
  request.once("error", abort);
  response.once("close", abort);
  response.once("error", abort);
  if (request.aborted || response.destroyed) abort();
  return {
    controller,
    cleanup() {
      request.off("aborted", abort);
      request.off("error", abort);
      response.off("close", abort);
      response.off("error", abort);
    },
  };
}

/** A full socket buffer requires waiting for drain, not ending the live stream. */
export async function writeSseChunk(
  response: ServerResponse,
  chunk: Uint8Array | string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      response.off("drain", drain);
      response.off("close", close);
      response.off("error", close);
      signal.removeEventListener("abort", close);
      resolve(ok);
    };
    const drain = () => finish(true);
    const close = () => finish(false);
    response.once("drain", drain);
    response.once("close", close);
    response.once("error", close);
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted || response.destroyed) close();
  });
}
