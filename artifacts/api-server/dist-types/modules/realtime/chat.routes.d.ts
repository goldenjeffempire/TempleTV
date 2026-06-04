import type { FastifyInstance } from "fastify";
/**
 * Stop the chat ping/sweep interval.
 * Called during graceful shutdown so the timer does not keep the event loop
 * alive after all other subsystems have stopped.
 */
export declare function stopChatPingInterval(): void;
export declare function chatRoutes(app: FastifyInstance): Promise<void>;
