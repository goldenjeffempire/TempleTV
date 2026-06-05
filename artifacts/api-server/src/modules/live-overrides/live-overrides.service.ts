import { and, desc, eq, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { NotFoundError, BadRequestError } from "../../shared/errors.js";
import type { StartOverrideBodySchema } from "./live-overrides.schemas.js";

const overrides = schema.liveOverridesTable;

function toDto(row: typeof overrides.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    isActive: row.isActive,
    hlsStreamUrl: row.hlsStreamUrl,
    youtubeVideoId: row.youtubeVideoId,
    rtmpIngestKey: row.rtmpIngestKey,
    streamNotes: row.streamNotes,
    startedAt: row.startedAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    autoStarted: row.autoStarted,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Extract the 11-character YouTube video id from any of the common URL
 * shapes (watch, youtu.be, embed, live, shorts) or accept a bare 11-char id.
 * Returns null on anything we can't recognise so the caller can decide.
 */
function extractYouTubeVideoId(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith("youtu.be")) {
      const id = u.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const seg = u.pathname.split("/").filter(Boolean);
      const idx = seg.findIndex((p) => ["embed", "live", "shorts", "v"].includes(p));
      if (idx >= 0 && seg[idx + 1] && /^[A-Za-z0-9_-]{11}$/.test(seg[idx + 1]!)) {
        return seg[idx + 1]!;
      }
    }
  } catch {
    /* not a URL */
  }
  return null;
}

export const liveOverridesService = {
  async getStatus() {
    const [row] = await db
      .select()
      .from(overrides)
      .where(eq(overrides.isActive, true))
      .orderBy(desc(overrides.startedAt))
      .limit(1);
    return { isLive: Boolean(row), active: row ? toDto(row) : null };
  },

  async start(body: z.infer<typeof StartOverrideBodySchema>) {
    const youtubeVideoId = extractYouTubeVideoId(body.youtubeUrl ?? null);
    if (body.youtubeUrl && !youtubeVideoId) {
      throw new BadRequestError(
        "youtubeUrl could not be parsed into a YouTube video id (expected an 11-char id)",
      );
    }

    const id = nanoid();
    // Wrap deactivate + insert in a single transaction so there is never a
    // window where no active override exists when one was just requested.
    const [row] = await db.transaction(async (tx) => {
      await tx
        .update(overrides)
        .set({ isActive: false, endsAt: new Date() })
        .where(eq(overrides.isActive, true));

      return tx
        .insert(overrides)
        .values({
          id,
          title: body.title,
          isActive: true,
          hlsStreamUrl: body.hlsStreamUrl ?? null,
          youtubeVideoId,
          rtmpIngestKey: body.rtmpIngestKey ?? null,
          streamNotes: body.streamNotes ?? null,
          endsAt: body.endsAt ? new Date(body.endsAt) : null,
          scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          autoStarted: false,
        })
        .returning();
    });
    return toDto(row!);
  },

  async stop() {
    const [active] = await db
      .select()
      .from(overrides)
      .where(eq(overrides.isActive, true))
      .orderBy(desc(overrides.startedAt))
      .limit(1);
    if (!active) throw new NotFoundError("No live override is currently active");
    const [row] = await db
      .update(overrides)
      .set({ isActive: false, endsAt: new Date() })
      .where(eq(overrides.id, active.id))
      .returning();
    return toDto(row!);
  },

  async listRecent(limit = 25) {
    const rows = await db
      .select()
      .from(overrides)
      .orderBy(desc(overrides.startedAt))
      .limit(limit);
    return { items: rows.map(toDto), total: rows.length };
  },

  /**
   * Extend the `endsAt` of the currently-active live override by `extraMinutes`.
   * If the override has no `endsAt`, one is set to `now + extraMinutes`.
   */
  async extend(extraMinutes: number) {
    const [active] = await db
      .select()
      .from(overrides)
      .where(eq(overrides.isActive, true))
      .orderBy(desc(overrides.startedAt))
      .limit(1);
    if (!active) throw new NotFoundError("No live override is currently active");
    const base = active.endsAt && active.endsAt > new Date() ? active.endsAt : new Date();
    const newEndsAt = new Date(base.getTime() + extraMinutes * 60_000);
    const [row] = await db
      .update(overrides)
      .set({ endsAt: newEndsAt })
      .where(eq(overrides.id, active.id))
      .returning();
    return toDto(row!);
  },

  /**
   * Create a new *scheduled* live override (isActive=false, scheduledFor set).
   * The auto-activation scheduler fires when `scheduledFor` is reached.
   */
  async schedule(body: z.infer<typeof StartOverrideBodySchema>) {
    if (!body.scheduledFor) {
      throw new BadRequestError("scheduledFor is required for scheduled overrides");
    }
    const youtubeVideoId = extractYouTubeVideoId(body.youtubeUrl ?? null);
    if (body.youtubeUrl && !youtubeVideoId) {
      throw new BadRequestError(
        "youtubeUrl could not be parsed into a YouTube video id (expected an 11-char id)",
      );
    }
    const id = nanoid();
    const [row] = await db
      .insert(overrides)
      .values({
        id,
        title: body.title,
        isActive: false,
        hlsStreamUrl: body.hlsStreamUrl ?? null,
        youtubeVideoId,
        rtmpIngestKey: body.rtmpIngestKey ?? null,
        streamNotes: body.streamNotes ?? null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        scheduledFor: new Date(body.scheduledFor),
        autoStarted: false,
      })
      .returning();
    return toDto(row!);
  },

  /**
   * List upcoming scheduled (not yet active) overrides, soonest first.
   */
  async listScheduled() {
    const now = new Date();
    const rows = await db
      .select()
      .from(overrides)
      .where(
        and(
          eq(overrides.isActive, false),
          gt(overrides.scheduledFor, now),
        ),
      )
      .orderBy(overrides.scheduledFor)
      .limit(50);
    return { items: rows.map(toDto), total: rows.length };
  },

  /**
   * Cancel (delete) a scheduled override that has not yet fired.
   * Refuses to delete an active or already-completed override.
   */
  async cancelScheduled(id: string) {
    const [row] = await db
      .select()
      .from(overrides)
      .where(eq(overrides.id, id))
      .limit(1);
    if (!row) throw new NotFoundError(`No override found with id ${id}`);
    if (row.isActive) throw new BadRequestError("Cannot cancel an already-active override — use /stop instead");
    await db.delete(overrides).where(eq(overrides.id, id));
    return { ok: true as const, id };
  },
};
