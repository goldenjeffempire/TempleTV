import type { FastifyInstance } from "fastify";
/**
 * Force-close every active realtime WS session.
 * Called during graceful shutdown before app.close() so event-listener
 * registrations on broadcastEngine/overrideBus/signalBus are released
 * and do not delay GC of the socket objects.
 */
export declare function closeAllRealtimeWsSessions(): void;
export declare function wsRoutes(app: FastifyInstance): Promise<void>;
