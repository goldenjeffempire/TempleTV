import { ChannelEngine } from "./channel-engine.js";
/**
 * ChannelRegistry — manages per-channel BroadcastEngine instances.
 *
 * The primary "temple-tv-live" channel is managed separately by the
 * existing `broadcastEngine` singleton (broadcast/queue.engine.ts) to
 * maintain backward compatibility with all existing clients.
 *
 * All additional channels created through the admin panel get their own
 * ChannelEngine instance here, each querying `channel_queue` filtered
 * by their channelId.
 */
declare class ChannelRegistry {
    private engines;
    boot(): Promise<void>;
    getOrCreate(channelId: string): Promise<ChannelEngine>;
    get(channelId: string): ChannelEngine | undefined;
    reload(channelId: string): Promise<void>;
    remove(channelId: string): Promise<void>;
    list(): Array<{
        channelId: string;
        running: boolean;
        viewerCount: number;
    }>;
}
export declare const channelRegistry: ChannelRegistry;
export {};
