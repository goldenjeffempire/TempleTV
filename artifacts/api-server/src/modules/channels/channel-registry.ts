import { eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
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
class ChannelRegistry {
  private engines = new Map<string, ChannelEngine>();

  /**
   * In-flight creation promises keyed by channelId.
   * Prevents two concurrent getOrCreate() calls for the same channel
   * from each constructing and starting their own ChannelEngine — which
   * would leave an orphaned engine with running timers and a DB cursor.
   */
  private loading = new Map<string, Promise<ChannelEngine>>();

  async boot(): Promise<void> {
    const rows = await db
      .select()
      .from(schema.channelsTable)
      .where(eq(schema.channelsTable.isActive, true));

    for (const channel of rows) {
      if (channel.isPrimary) continue; // primary uses broadcastEngine
      await this.getOrCreate(channel.id);
    }

    logger.info(
      { channels: rows.length, engines: this.engines.size },
      "channel registry booted",
    );
  }

  async getOrCreate(channelId: string): Promise<ChannelEngine> {
    const existing = this.engines.get(channelId);
    if (existing) return existing;

    // If another concurrent call is already creating this engine, wait for
    // it instead of creating a second one.  Without this guard, two parallel
    // HTTP requests to the same new channel would both pass the engines.get()
    // check, both construct a ChannelEngine, and both call start() — resulting
    // in two active tick loops and two sets of DB poll intervals.
    const inflight = this.loading.get(channelId);
    if (inflight) return inflight;

    const promise = (async () => {
      const engine = new ChannelEngine(channelId);
      this.engines.set(channelId, engine);
      await engine.start();
      this.loading.delete(channelId);
      return engine;
    })();

    this.loading.set(channelId, promise);
    return promise;
  }

  get(channelId: string): ChannelEngine | undefined {
    return this.engines.get(channelId);
  }

  async reload(channelId: string): Promise<void> {
    const engine = this.engines.get(channelId);
    if (engine) {
      await engine.reload();
    }
  }

  async remove(channelId: string): Promise<void> {
    const engine = this.engines.get(channelId);
    if (engine) {
      engine.stop();
      this.engines.delete(channelId);
    }
  }

  list(): Array<{ channelId: string; running: boolean; viewerCount: number }> {
    return Array.from(this.engines.entries()).map(([id, engine]) => ({
      channelId: id,
      running: engine.isRunning(),
      viewerCount: engine.getViewerCount(),
    }));
  }

  /**
   * Stop all managed channel engines and clear the registry.
   * Must be called during graceful shutdown so timers and DB pool
   * connections held by secondary ChannelEngine instances are released
   * before `process.exit()`. Without this, those timers keep the event
   * loop alive past the supervisor's hard-kill timeout and prevent clean
   * connection pool drain.
   */
  shutdown(): void {
    for (const [channelId, engine] of this.engines) {
      try {
        engine.stop();
      } catch {
        // Non-fatal — engine may already be stopped.
      }
      logger.info({ channelId }, "channel engine stopped (shutdown)");
    }
    this.engines.clear();
    this.loading.clear();
  }
}

export const channelRegistry = new ChannelRegistry();
