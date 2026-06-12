/**
 * App Version Routes
 *
 * Public:
 *   GET  /app/version-check   — mobile clients check for available updates
 *
 * Admin (editor+):
 *   GET  /admin/app/versions              — list all version records
 *   POST /admin/app/versions              — create a new version record
 *   PATCH /admin/app/versions/:id         — update a version record
 *   DELETE /admin/app/versions/:id        — delete a version record
 *   POST /admin/app/versions/:id/send-notification  — push update alert to all users
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { nanoid } from "nanoid";
import { eq, desc, and, or } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { logger } from "../../infrastructure/logger.js";

const _429 = z.object({ error: z.string() });

// ── Semver comparison ─────────────────────────────────────────────────────────

function parseSemver(v: string): [number, number, number] {
  const p = v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

function semverGt(a: string, b: string): boolean {
  const [a0, a1, a2] = parseSemver(a);
  const [b0, b1, b2] = parseSemver(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

function semverLt(a: string, b: string): boolean {
  return semverGt(b, a);
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const AppVersionSchema = z.object({
  id:                   z.string(),
  platform:             z.enum(["ios", "android", "all"]),
  versionString:        z.string(),
  versionCode:          z.number().int().nonnegative(),
  channel:              z.enum(["production", "staging", "preview"]),
  isMandatory:          z.boolean(),
  minRequiredVersion:   z.string().nullable(),
  releaseNotes:         z.string().nullable(),
  storeUrlAndroid:      z.string().nullable(),
  storeUrlIos:          z.string().nullable(),
  pushNotificationSent: z.boolean(),
  isActive:             z.boolean(),
  createdAt:            z.string(),
  updatedAt:            z.string(),
});

const VersionCheckResponseSchema = z.object({
  updateAvailable:    z.boolean(),
  isMandatory:        z.boolean(),
  latestVersion:      z.string(),
  latestVersionCode:  z.number().int(),
  minRequiredVersion: z.string().nullable(),
  releaseNotes:       z.string().nullable(),
  storeUrl:           z.string().nullable(),
  channel:            z.string(),
});

const CreateVersionBodySchema = z.object({
  platform:           z.enum(["ios", "android", "all"]).default("all"),
  versionString:      z.string().min(1).max(20),
  versionCode:        z.number().int().nonnegative().default(0),
  channel:            z.enum(["production", "staging", "preview"]).default("production"),
  isMandatory:        z.boolean().default(false),
  minRequiredVersion: z.string().max(20).nullable().optional(),
  releaseNotes:       z.string().max(2000).nullable().optional(),
  storeUrlAndroid:    z.string().url().nullable().optional(),
  storeUrlIos:        z.string().url().nullable().optional(),
  isActive:           z.boolean().default(true),
});

const UpdateVersionBodySchema = CreateVersionBodySchema.partial();

// ── Row mapper ────────────────────────────────────────────────────────────────

function toDto(row: typeof schema.appVersionsTable.$inferSelect) {
  return {
    id:                   row.id,
    platform:             row.platform,
    versionString:        row.versionString,
    versionCode:          row.versionCode,
    channel:              row.channel,
    isMandatory:          row.isMandatory,
    minRequiredVersion:   row.minRequiredVersion ?? null,
    releaseNotes:         row.releaseNotes ?? null,
    storeUrlAndroid:      row.storeUrlAndroid ?? null,
    storeUrlIos:          row.storeUrlIos ?? null,
    pushNotificationSent: row.pushNotificationSent,
    isActive:             row.isActive,
    createdAt:            row.createdAt.toISOString(),
    updatedAt:            row.updatedAt.toISOString(),
  };
}

// ── Route module ──────────────────────────────────────────────────────────────

export async function appVersionRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Public: version check ─────────────────────────────────────────────────

  r.get(
    "/app/version-check",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["app-version"],
        summary: "Check if an app update is available for the given platform/version",
        querystring: z.object({
          platform:    z.enum(["ios", "android"]),
          version:     z.string().min(1).max(20),
          versionCode: z.coerce.number().int().nonnegative().default(0),
          channel:     z.string().max(64).default("production"),
        }),
        response: {
          200: VersionCheckResponseSchema,
          429: _429,
        },
      },
    },
    async (req, reply) => {
      // Version check is polled by mobile on every cold start + AppState active.
      // App version records change rarely (only when an admin publishes a new
      // release). 30 s public cache dramatically reduces DB hits during
      // user-launch spikes. stale-if-error=600 keeps mobile from showing
      // "update required" interstitials during a brief origin restart.
      reply
        .header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=60, stale-if-error=600")
        .header("Vary", "Accept-Encoding");
      const { platform, version, versionCode, channel } = req.query;

      // Fetch active versions matching this platform+channel
      const rows = await db
        .select()
        .from(schema.appVersionsTable)
        .where(
          and(
            eq(schema.appVersionsTable.isActive, true),
            eq(schema.appVersionsTable.channel, channel as "production" | "staging" | "preview"),
            or(
              eq(schema.appVersionsTable.platform, platform),
              eq(schema.appVersionsTable.platform, "all"),
            ),
          ),
        )
        .orderBy(desc(schema.appVersionsTable.createdAt));

      // Latest version record (most recently created active record)
      const latest = rows[0];

      if (!latest) {
        return {
          updateAvailable:    false,
          isMandatory:        false,
          latestVersion:      version,
          latestVersionCode:  versionCode,
          minRequiredVersion: null,
          releaseNotes:       null,
          storeUrl:           null,
          channel,
        };
      }

      const updateAvailable = semverGt(latest.versionString, version);

      // Mandatory: explicit flag OR current < minRequiredVersion
      const minRequired = latest.minRequiredVersion ?? null;
      const isMandatory =
        (updateAvailable && latest.isMandatory) ||
        (minRequired != null && semverLt(version, minRequired));

      const storeUrl =
        platform === "android"
          ? (latest.storeUrlAndroid ?? "https://play.google.com/store/apps/details?id=com.templetv.jctm")
          : (latest.storeUrlIos ?? "https://apps.apple.com/app/id6474801551");

      return {
        updateAvailable,
        isMandatory,
        latestVersion:      latest.versionString,
        latestVersionCode:  latest.versionCode,
        minRequiredVersion: minRequired,
        releaseNotes:       latest.releaseNotes ?? null,
        storeUrl:           updateAvailable ? storeUrl : null,
        channel,
      };
    },
  );

  // ── Admin: list versions ───────────────────────────────────────────────────

  r.get(
    "/admin/app/versions",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["app-version"],
        summary: "List all app version records",
        querystring: z.object({
          limit:  z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().nonnegative().default(0),
        }),
        response: {
          200: z.object({
            items: z.array(AppVersionSchema),
            total: z.number().int().nonnegative(),
          }),
          429: _429,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const rows = await db
        .select()
        .from(schema.appVersionsTable)
        .orderBy(desc(schema.appVersionsTable.createdAt))
        .limit(limit)
        .offset(offset);

      const total = rows.length; // Good enough for small table
      return { items: rows.map(toDto), total };
    },
  );

  // ── Admin: create version ─────────────────────────────────────────────────

  r.post(
    "/admin/app/versions",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["app-version"],
        summary: "Create a new app version record",
        body: CreateVersionBodySchema,
        response: {
          201: AppVersionSchema,
          409: z.object({ error: z.string() }),
          429: _429,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body;

      // Prevent duplicate version+platform+channel records
      const existing = await db
        .select({ id: schema.appVersionsTable.id })
        .from(schema.appVersionsTable)
        .where(
          and(
            eq(schema.appVersionsTable.versionString, body.versionString),
            eq(schema.appVersionsTable.platform, body.platform),
            eq(schema.appVersionsTable.channel, body.channel),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        return reply.code(409).send({ error: `Version ${body.versionString} for ${body.platform}/${body.channel} already exists` });
      }

      const id  = nanoid();
      const now = new Date();

      await db.insert(schema.appVersionsTable).values({
        id,
        platform:           body.platform,
        versionString:      body.versionString,
        versionCode:        body.versionCode,
        channel:            body.channel,
        isMandatory:        body.isMandatory,
        minRequiredVersion: body.minRequiredVersion ?? null,
        releaseNotes:       body.releaseNotes ?? null,
        storeUrlAndroid:    body.storeUrlAndroid ?? null,
        storeUrlIos:        body.storeUrlIos ?? null,
        isActive:           body.isActive,
        pushNotificationSent: false,
        createdAt:          now,
        updatedAt:          now,
      });

      const [row] = await db
        .select()
        .from(schema.appVersionsTable)
        .where(eq(schema.appVersionsTable.id, id))
        .limit(1);

      if (!row) throw new Error("Failed to fetch created record after insert");

      logger.info({ id, versionString: body.versionString }, "[app-version] created");
      return reply.code(201).send(toDto(row));
    },
  );

  // ── Admin: update version ─────────────────────────────────────────────────

  r.patch(
    "/admin/app/versions/:id",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["app-version"],
        summary: "Update an app version record",
        params: z.object({ id: z.string().min(1) }),
        body: UpdateVersionBodySchema,
        response: {
          200: AppVersionSchema,
          404: z.object({ error: z.string() }),
          429: _429,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const updates: Partial<typeof schema.appVersionsTable.$inferInsert> = {
        updatedAt: new Date(),
      };

      const b = req.body;
      if (b.platform           !== undefined) updates.platform           = b.platform;
      if (b.versionString      !== undefined) updates.versionString      = b.versionString;
      if (b.versionCode        !== undefined) updates.versionCode        = b.versionCode;
      if (b.channel            !== undefined) updates.channel            = b.channel;
      if (b.isMandatory        !== undefined) updates.isMandatory        = b.isMandatory;
      if (b.minRequiredVersion !== undefined) updates.minRequiredVersion = b.minRequiredVersion ?? null;
      if (b.releaseNotes       !== undefined) updates.releaseNotes       = b.releaseNotes ?? null;
      if (b.storeUrlAndroid    !== undefined) updates.storeUrlAndroid    = b.storeUrlAndroid ?? null;
      if (b.storeUrlIos        !== undefined) updates.storeUrlIos        = b.storeUrlIos ?? null;
      if (b.isActive           !== undefined) updates.isActive           = b.isActive;

      const result = await db
        .update(schema.appVersionsTable)
        .set(updates)
        .where(eq(schema.appVersionsTable.id, id))
        .returning();

      if (!result[0]) return reply.code(404).send({ error: "Version record not found" });

      logger.info({ id }, "[app-version] updated");
      return toDto(result[0]);
    },
  );

  // ── Admin: delete version ─────────────────────────────────────────────────

  r.delete(
    "/admin/app/versions/:id",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["app-version"],
        summary: "Delete an app version record",
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: z.object({ error: z.string() }),
          429: _429,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const result = await db
        .delete(schema.appVersionsTable)
        .where(eq(schema.appVersionsTable.id, id))
        .returning({ id: schema.appVersionsTable.id });

      if (!result[0]) return reply.code(404).send({ error: "Version record not found" });
      logger.info({ id }, "[app-version] deleted");
      return { ok: true as const };
    },
  );

  // ── Admin: send update push notification ─────────────────────────────────

  r.post(
    "/admin/app/versions/:id/send-notification",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["app-version"],
        summary: "Send a push notification announcing this app update to all users",
        params: z.object({ id: z.string().min(1) }),
        body: z.object({
          title:   z.string().min(1).max(120).default("Temple TV Update Available"),
          message: z.string().min(1).max(500).default("A new version of Temple TV is ready. Update now for the latest features."),
        }),
        response: {
          200: z.object({
            ok:            z.literal(true),
            delivered:     z.number().int().nonnegative(),
            failedTokens:  z.number().int().nonnegative(),
          }),
          404: z.object({ error: z.string() }),
          429: _429,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { title, message } = req.body;

      const [versionRow] = await db
        .select()
        .from(schema.appVersionsTable)
        .where(eq(schema.appVersionsTable.id, id))
        .limit(1);

      if (!versionRow) return reply.code(404).send({ error: "Version record not found" });

      // Dynamically import the notifications service to avoid circular deps
      const { notificationsService } = await import(
        "../notifications/notifications.service.js"
      );

      const result = await notificationsService.sendPush({
        title,
        body:  message,
        type:  "app_update",
      });

      // Mark notification as sent
      await db
        .update(schema.appVersionsTable)
        .set({ pushNotificationSent: true, updatedAt: new Date() })
        .where(eq(schema.appVersionsTable.id, id));

      logger.info({ id, delivered: result.delivered }, "[app-version] update notification sent");

      return {
        ok:           true as const,
        delivered:    result.delivered ?? result.recipients ?? 0,
        failedTokens: 0,
      };
    },
  );
}
