import type { FastifyInstance } from "fastify";
import { type BroadcastCurrentResultDto } from "./broadcast.schemas.js";
import type { BroadcastSnapshot } from "./queue.engine.js";
import type { ActiveOverrideEntry } from "../live-overrides/override-bus.js";
export interface LiveReactionEvent {
    type: ReactionType;
    channelId: string;
    serverTimeMs: number;
}
export type ReactionType = "amen" | "fire" | "hallelujah";
/**
 * Project the engine's internal BroadcastSnapshot into the
 * BroadcastCurrentResult shape that mobile clients (React Native / Expo)
 * expect from GET /broadcast/current and the broadcast-current-updated SSE
 * event. These fields map to `normalizeBroadcastResult()` in
 * `artifacts/mobile/services/broadcast.ts`.
 *
 * The engine snapshot uses `current`/`next` field names and lacks derived
 * fields like `positionSecs`. The projection adds them so mobile can render
 * the cinematic hero, progress bar, and broadcast player without a separate
 * HTTP call.
 */
export declare function snapshotToCurrentResult(snap: BroadcastSnapshot, active?: ActiveOverrideEntry | null): BroadcastCurrentResultDto;
export declare function broadcastRoutes(app: FastifyInstance): Promise<void>;
