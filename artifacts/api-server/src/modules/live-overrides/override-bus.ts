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
import { eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";

export interface ActiveOverrideEntry {
  id: string;
  title: string;
  hlsStreamUrl: string | null;
  youtubeVideoId: string | null;
  startedAt: string;
  endsAt: string | null;
}

export type OverrideBusChange =
  | { type: "started"; override: ActiveOverrideEntry }
  | { type: "stopped" };

class OverrideBus extends EventEmitter {
  private _active: ActiveOverrideEntry | null = null;

  /** The currently active override, or null if none. Safe to read from any sync code. */
  get active(): ActiveOverrideEntry | null {
    return this._active;
  }

  /**
   * Hydrate the in-memory cache from the database. Called once at startup so
   * buildState() has the right answer before the first WS or SSE connection.
   */
  async init(): Promise<void> {
    try {
      const [row] = await db
        .select()
        .from(schema.liveOverridesTable)
        .where(eq(schema.liveOverridesTable.isActive, true))
        .limit(1);
      this._active = row
        ? {
            id: row.id,
            title: row.title,
            hlsStreamUrl: row.hlsStreamUrl,
            youtubeVideoId: row.youtubeVideoId,
            startedAt: row.startedAt.toISOString(),
            endsAt: row.endsAt?.toISOString() ?? null,
          }
        : null;
    } catch {
      // Non-fatal — if DB is briefly unavailable at boot we start with null
      // and operators can restart the active override to re-sync.
      this._active = null;
    }
  }

  /** Call after a successful override start in the routes layer. */
  notifyStarted(override: ActiveOverrideEntry): void {
    this._active = override;
    this.emit("change", { type: "started", override } satisfies OverrideBusChange);
  }

  /** Call after a successful override stop in the routes layer. */
  notifyStopped(): void {
    this._active = null;
    this.emit("change", { type: "stopped" } satisfies OverrideBusChange);
  }
}

export const overrideBus = new OverrideBus();
overrideBus.setMaxListeners(1024);
