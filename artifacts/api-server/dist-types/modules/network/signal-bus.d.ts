/**
 * signal-bus — OMEGA Realtime Signal Bus
 *
 * Implements the OMEGA SYNC PLANE: a typed event bus that fans out
 * broadcast-network signals to every connected client simultaneously.
 *
 * Signal taxonomy:
 *   PROGRAM_CHANGED      → current program advanced (engine tick)
 *   STREAM_FAILED        → primary stream is down / stale
 *   SYNC_REQUIRED        → all clients must re-sync position
 *   EMERGENCY_BROADCAST  → emergency override activated (highest priority)
 *   FAILOVER_ACTIVATED   → engine switched to backup/fallback source
 *   BROADCAST_LOCKED     → admin locked the broadcast (no-change gate)
 *   BROADCAST_UNLOCKED   → admin unlocked the broadcast
 *   NODE_HEALTH_CHANGED  → server node health state changed
 *
 * The WS gateway (playback.routes.ts) and SSE gateway (broadcast.routes.ts)
 * subscribe to this bus and push each signal as a typed envelope to every
 * connected client. Clients use the signal type to decide whether to resync,
 * surface an emergency overlay, or quietly update their UI.
 *
 * Transport contract:
 *   WS:  { type: "signal", signal: OmegaSignal }
 *   SSE: event: omega-signal  data: <JSON>
 */
import { EventEmitter } from "node:events";
export type OmegaSignalType = "PROGRAM_CHANGED" | "STREAM_FAILED" | "SYNC_REQUIRED" | "EMERGENCY_BROADCAST" | "FAILOVER_ACTIVATED" | "BROADCAST_LOCKED" | "BROADCAST_UNLOCKED" | "NODE_HEALTH_CHANGED";
export interface OmegaSignal {
    type: OmegaSignalType;
    channelId: string;
    serverTimeMs: number;
    /** Human-readable description of the signal (shown in admin NOC). */
    message?: string;
    /** Arbitrary signal-specific context. */
    payload?: Record<string, unknown>;
}
declare class SignalBus extends EventEmitter {
    emit(eventName: "signal", signal: OmegaSignal): boolean;
    on(eventName: "signal", listener: (signal: OmegaSignal) => void): this;
    off(eventName: "signal", listener: (signal: OmegaSignal) => void): this;
}
export declare const signalBus: SignalBus;
/** Convenience emitter — call this instead of signalBus.emit() directly. */
export declare function broadcastSignal(type: OmegaSignalType, channelId: string, opts?: {
    message?: string;
    payload?: Record<string, unknown>;
}): void;
export {};
