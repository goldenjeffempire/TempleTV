import type { FastifyInstance } from "fastify";
export declare function closeAllRealtimeSseSessions(): void;
export declare function sseRoutes(app: FastifyInstance): Promise<void>;
