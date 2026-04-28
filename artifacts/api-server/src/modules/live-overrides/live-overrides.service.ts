import { and, desc, eq, isNull, or } from "drizzle-orm";
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

    // Deactivate any prior live row so getStatus() is unambiguous.
    await db
      .update(overrides)
      .set({ isActive: false, endsAt: new Date() })
      .where(eq(overrides.isActive, true));

    const id = nanoid();
    const [row] = await db
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
};
