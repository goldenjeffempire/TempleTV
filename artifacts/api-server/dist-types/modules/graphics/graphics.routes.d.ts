import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
/**
 * On-Air Graphics Bus — fans out graphic activation/deactivation events
 * to all connected SSE clients in real time. No polling required.
 */
export declare class GraphicsBus extends EventEmitter {
}
export declare const graphicsBus: GraphicsBus;
export declare function closeAllGraphicsSseSessions(): void;
export interface GraphicsEvent {
    type: "graphic-activated" | "graphic-deactivated" | "graphics-snapshot";
    channelId: string;
    graphic?: {
        id: string;
        type: string;
        content: string;
        subContent: string | null;
        durationSecs: number | null;
    };
    allActive?: Array<{
        id: string;
        type: string;
        content: string;
        subContent: string | null;
        durationSecs: number | null;
    }>;
}
export declare function graphicsRoutes(app: FastifyInstance): Promise<void>;
