/**
 * Admin System Settings — read/write the app_config key-value store.
 *
 * Routes:
 *   GET  /admin/system-settings          — list all config keys
 *   PUT  /admin/system-settings          — upsert a key-value pair
 *   DELETE /admin/system-settings/:key   — remove a config key
 *
 * The app_config table is a generic k/v store for runtime flags,
 * feature toggles, SMTP settings, broadcast metadata, etc.
 * All values are stored as text; the admin UI handles type coercion.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";

const ConfigEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  updatedAt: z.string(),
});

export async function settingsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── List all settings ──────────────────────────────────────────────────────
  r.get(
    "/system-settings",
    {
      preHandler: requireAuth("admin"),
      schema: {
        tags: ["admin"],
        summary: "List all system settings (app_config)",
        response: {
          200: z.object({
            settings: z.array(ConfigEntrySchema),
          }),
        },
      },
    },
    async (_req, reply) => {
      try {
        const rows = await db
          .select()
          .from(schema.appConfigTable)
          .orderBy(asc(schema.appConfigTable.key));

        return reply.send({
          settings: rows.map((r) => ({
            key: r.key,
            value: String(r.value ?? ""),
            updatedAt: r.updatedAt?.toISOString() ?? new Date().toISOString(),
          })),
        });
      } catch {
        return reply.send({ settings: [] });
      }
    },
  );

  // ── Upsert a setting ───────────────────────────────────────────────────────
  r.put(
    "/system-settings",
    {
      preHandler: requireAuth("admin"),
      // System settings are global runtime flags that apply immediately.
      // 20/min lets bulk import flows work while bounding write storms.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Create or update a system setting",
        body: z.object({
          key: z.string().min(1).max(128).regex(/^[a-z0-9_:./-]+$/i),
          value: z.string().max(4096),
        }),
        response: {
          200: ConfigEntrySchema,
        },
      },
    },
    async (req, reply) => {
      const { key, value } = req.body;
      const now = new Date();

      try {
        const [row] = await db
          .insert(schema.appConfigTable)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({
            target: schema.appConfigTable.key,
            set: { value, updatedAt: now },
          })
          .returning();

        return reply.send({
          key: row!.key,
          value: String(row!.value ?? ""),
          updatedAt: row!.updatedAt?.toISOString() ?? now.toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to save setting: ${msg}`);
      }
    },
  );

  // ── Delete a setting ───────────────────────────────────────────────────────
  r.delete(
    "/system-settings/:key",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Delete a system setting by key",
        params: z.object({ key: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      try {
        await db
          .delete(schema.appConfigTable)
          .where(eq(schema.appConfigTable.key, req.params.key));
      } catch {
        /* ignore — idempotent delete */
      }
      return reply.code(204).send(null);
    },
  );
}
