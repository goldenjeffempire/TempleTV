/**
 * override-bus — in-memory cache + event bus for live-override state.
 *
 * Why a separate module?
 *   The live-overrides routes write to the DB and need to immediately push
 *   the new state to every connected WS client and SSE subscriber. Doing
 *   that via a DB query on every engine tick (or per-connection poll) would
 *   add a round-trip to every playback state build. Instead we keep one
 *   authoritative in-memory copy that is:
 *
 *     - Hydrated from the DB once at startup  (init)
 *     - Updated synchronously after every admin start/stop  (notify*)
 *     - Read lock-free by buildState() in the WS gateway and the SSE emitter
 *
 *   Because Node.js is single-threaded there are no data races between
 *   the notify* calls and the reads in event handlers.
 */
import { EventEmitter } from "node:events";
export interface ActiveOverrideEntry {
    id: string;
    title: string;
    hlsStreamUrl: string | null;
    youtubeVideoId: string | null;
    startedAt: string;
    endsAt: string | null;
}
export type OverrideBusChange = {
    type: "started";
    override: ActiveOverrideEntry;
} | {
    type: "stopped";
};
declare class OverrideBus extends EventEmitter {
    private _active;
    /** The currently active override, or null if none. Safe to read from any sync code. */
    get active(): ActiveOverrideEntry | null;
    /**
     * Hydrate the in-memory cache from the database. Called once at startup so
     * buildState() has the right answer before the first WS or SSE connection.
     */
    init(): Promise<void>;
    /** Call after a successful override start in the routes layer. */
    notifyStarted(override: ActiveOverrideEntry): void;
    /** Call after a successful override stop in the routes layer. */
    notifyStopped(): void;
}
export declare const overrideBus: OverrideBus;
export {};
