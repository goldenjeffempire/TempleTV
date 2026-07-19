import type { FastifyInstance } from "fastify";
export declare function closeAllBroadcastV2WsSessions(): void;
export declare function getBroadcastV2WsViewerCount(): number;
/**
 * Broadcast a graceful-restart hint to all currently-connected WebSocket
 * clients WITHOUT closing the connections.  Called by main.ts immediately
 * after SIGTERM while the SHUTDOWN_PRECLOSE_DELAY_MS window is still open.
 *
 * Clients that receive this frame schedule a reconnect timer for
 * `retryAfterMs` ms, avoiding a thundering-herd reconnect storm during the
 * drain window and giving the new process time to boot.
 */
export declare function broadcastReconnectHintToWs(retryAfterMs: number): void;
export declare function wsRoutes(app: FastifyInstance): Promise<void>;
