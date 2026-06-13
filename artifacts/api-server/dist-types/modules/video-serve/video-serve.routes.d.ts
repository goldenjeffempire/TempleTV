import type { FastifyInstance } from "fastify";
import { makeHlsToken } from "../../shared/hls-token.js";
export { makeHlsToken };
export declare function videoServeRoutes(app: FastifyInstance): Promise<void>;
