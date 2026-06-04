import { WebSocket as NodeWsWebSocket } from "ws";

/**
 * Global `WebSocket` polyfill for the test runtime.
 *
 * The broadcast-v2 WS integration tests open real client connections via the
 * browser-style `new WebSocket(url)` API. Node 22+ (the project's target
 * runtime, used in CI) ships a global `WebSocket`, so this polyfill is a no-op
 * there. On older runtimes (e.g. the Replit dev shell running Node 20) the
 * global is absent — without this shim the WS helpers either throw a
 * `ReferenceError` or silently catch it and no-op, so the gateway is never
 * actually exercised. The `ws` implementation mirrors the browser WebSocket
 * event interface (onopen/onmessage/onclose/onerror/send/close/readyState/OPEN)
 * used by those helpers.
 */
const g = globalThis as unknown as { WebSocket?: unknown };
if (typeof g.WebSocket === "undefined") {
  g.WebSocket = NodeWsWebSocket as unknown;
}
