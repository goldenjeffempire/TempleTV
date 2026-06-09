/**
 * Radio Station module — stores and serves live radio stream configuration.
 *
 * All config lives in the `app_config` key-value table under the `radio:*`
 * namespace. This means zero schema migrations are required to deploy the
 * radio feature — the table already exists and is designed for exactly
 * this kind of runtime flag storage.
 *
 * Public endpoint:
 *   GET  /api/radio        → streamUrl, title, description, isActive
 *   GET  /api/v1/radio     (dual-prefix; same handler)
 *
 * Admin endpoints (system / admin role required):
 *   GET  /api/admin/radio
 *   PATCH /api/admin/radio
 *   (and their /api/v1/admin/* counterparts via dual-prefix registration)
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";

// ── Config key namespace ──────────────────────────────────────────────────────
const KEYS = {
  streamUrl:   "radio:stream_url",
  title:       "radio:title",
  description: "radio:description",
  isActive:    "radio:is_active",
} as const;

const ALL_KEYS = Object.values(KEYS) as string[];

// ── Response schema (shared by public + admin reads) ─────────────────────────
const RadioConfigSchema = z.object({
  streamUrl:   z.string().nullable(),
  title:       z.string(),
  description: z.string(),
  isActive:    z.boolean(),
});

type RadioConfig = z.infer<typeof RadioConfigSchema>;

// ── Config reader ─────────────────────────────────────────────────────────────
async function readConfig(): Promise<RadioConfig> {
  const rows = await db
    .select({ key: schema.appConfigTable.key, value: schema.appConfigTable.value })
    .from(schema.appConfigTable)
    .where(inArray(schema.appConfigTable.key, ALL_KEYS));

  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;

  const rawUrl = map[KEYS.streamUrl];
  return {
    streamUrl:   rawUrl && rawUrl.length > 0 ? rawUrl : null,
    title:       map[KEYS.title]       ?? "Temple TV Radio",
    description: map[KEYS.description] ?? "Live 24/7 Christian broadcast",
    isActive:    map[KEYS.isActive]    === "true",
  };
}

// ── Config writer (upsert one key) ────────────────────────────────────────────
async function upsertKey(key: string, value: string) {
  await db
    .insert(schema.appConfigTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.appConfigTable.key,
      set: { value, updatedAt: new Date() },
    });
}

// ── Route registration ────────────────────────────────────────────────────────
// Registered inside `registerDomainRoutes` with NO sub-prefix so paths
// are relative to the parent prefix (/api or /api/v1).
//
//   Parent /api   → GET  /api/radio          PATCH /api/admin/radio
//   Parent /api/v1 → GET  /api/v1/radio       PATCH /api/v1/admin/radio
export async function radioRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Public: get radio stream config ────────────────────────────────────────
  // Cached for 30 s at CDN / proxy layer — config changes only when an admin
  // updates it, not on every request. Mobile + TV clients poll this on mount.
  r.get(
    "/radio",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["radio"],
        summary: "Get radio station config (public)",
        response: { 200: RadioConfigSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (_req, reply) => {
      reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
      return readConfig();
    },
  );

  // ── Admin: read config ──────────────────────────────────────────────────────
  r.get(
    "/admin/radio",
    {
      onRequest: [requireAuth("admin")],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["radio"],
        summary: "Get radio station config (admin)",
        response: { 200: RadioConfigSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async () => readConfig(),
  );

  // ── Admin: update config ────────────────────────────────────────────────────
  r.patch(
    "/admin/radio",
    {
      onRequest: [requireAuth("admin")],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["radio"],
        summary: "Update radio station config (admin)",
        body: z.object({
          streamUrl:   z.string().url("Stream URL must be a valid URL").nullable().optional(),
          title:       z.string().min(1).max(100).optional(),
          description: z.string().max(400).optional(),
          isActive:    z.boolean().optional(),
        }),
        response: { 200: RadioConfigSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      const { streamUrl, title, description, isActive } = req.body;

      const writes: Array<[string, string]> = [];
      if (streamUrl !== undefined) writes.push([KEYS.streamUrl, streamUrl ?? ""]);
      if (title       !== undefined) writes.push([KEYS.title,       title]);
      if (description !== undefined) writes.push([KEYS.description, description]);
      if (isActive    !== undefined) writes.push([KEYS.isActive,    String(isActive)]);

      await Promise.all(writes.map(([k, v]) => upsertKey(k, v)));
      return readConfig();
    },
  );
}
