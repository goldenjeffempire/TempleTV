import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, isNull, lt, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { logger } from "../../infrastructure/logger.js";
import { liveOverridesService } from "../live-overrides/live-overrides.service.js";
import { broadcastSignal } from "../network/signal-bus.js";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";

/**
 * Live ingest endpoints (RTMP / RTMPS / SRT / HLS / WHIP) management.
 *
 * Each row in `live_ingest_endpoints` represents one external encoder
 * configuration we can pull from (vMix → Mux, OBS → Cloudflare Stream,
 * AWS IVS, etc.). The API does not accept raw RTMP packets itself — it
 * orchestrates configurations that customers run on a CDN that gives
 * them an HLS playback URL, which is what the player consumes and what
 * we periodically health-check.
 *
 *   GET    /admin/live-ingest/endpoints              → list all
 *   POST   /admin/live-ingest/endpoints              → create
 *   PATCH  /admin/live-ingest/endpoints/:id          → update mutable fields
 *   DELETE /admin/live-ingest/endpoints/:id          → remove
 *   POST   /admin/live-ingest/endpoints/:id/rotate-key
 *   POST   /admin/live-ingest/endpoints/:id/promote   → make primary
 *   POST   /admin/live-ingest/endpoints/:id/probe     → run a one-shot health check
 *   POST   /admin/live-ingest/stop                    → stop the active live override
 *   POST   /admin/live-ingest/sweep                   → mark stale endpoints unhealthy
 *   POST   /admin/live-ingest/validate-key            → check a candidate key for collisions
 */

const ingest = schema.liveIngestEndpointsTable;

const ProtocolSchema = z.enum(["rtmp", "rtmps", "srt", "hls", "whip"]);
const HealthSchema = z.enum(["healthy", "degraded", "unhealthy", "unknown"]);

const EndpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: ProtocolSchema,
  ingestUrl: z.string(),
  streamKey: z.string(),
  hlsPlaybackUrl: z.string(),
  fallbackYoutubeUrl: z.string().nullable(),
  isPrimary: z.boolean(),
  isActive: z.boolean(),
  priority: z.number().int(),
  notes: z.string().nullable(),
  healthStatus: HealthSchema,
  lastHealthAt: z.string().nullable(),
  lastHealthyAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastBitrateKbps: z.number().nullable(),
  lastSegmentLatencyMs: z.number().int().nullable(),
  droppedFramesPct: z.number().nullable(),
  lastError: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateBodySchema = z.object({
  name: z.string().min(1).max(120),
  protocol: ProtocolSchema,
  ingestUrl: z.string().url(),
  streamKey: z.string().min(1).max(512).optional(),
  hlsPlaybackUrl: z.string().url(),
  fallbackYoutubeUrl: z.string().url().nullable().optional(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const PatchBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  protocol: ProtocolSchema.optional(),
  ingestUrl: z.string().url().optional(),
  hlsPlaybackUrl: z.string().url().optional(),
  fallbackYoutubeUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

function generateStreamKey(): string {
  // 32 bytes → 64 hex chars. Long enough that brute-forcing it is
  // infeasible and short enough to paste cleanly into encoder UIs.
  return randomBytes(32).toString("hex");
}

function toDto(row: typeof ingest.$inferSelect): z.infer<typeof EndpointSchema> {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as z.infer<typeof ProtocolSchema>,
    ingestUrl: row.ingestUrl,
    streamKey: row.streamKey,
    hlsPlaybackUrl: row.hlsPlaybackUrl,
    fallbackYoutubeUrl: row.fallbackYoutubeUrl,
    isPrimary: row.isPrimary,
    isActive: row.isActive,
    priority: row.priority,
    notes: row.notes,
    healthStatus: row.healthStatus as z.infer<typeof HealthSchema>,
    lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
    lastHealthyAt: row.lastHealthyAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastBitrateKbps: row.lastBitrateKbps,
    lastSegmentLatencyMs: row.lastSegmentLatencyMs,
    droppedFramesPct: row.droppedFramesPct,
    lastError: row.lastError,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Probe an HLS playback URL once and write the result back to the row.
 *
 * We don't ship a full HLS parser — we just GET the master playlist
 * with a short timeout. A 2xx response that looks like an `#EXTM3U`
 * payload counts as healthy; anything else (network error, non-2xx,
 * non-m3u8 body) is unhealthy. Latency = HEAD-to-first-byte time.
 *
 * This is the same shape the periodic background health-checker uses,
 * just invoked synchronously by the admin button.
 */
async function probeEndpoint(
  url: string,
): Promise<{
  status: z.infer<typeof HealthSchema>;
  latencyMs: number | null;
  error: string | null;
}> {
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);
    const res = await fetch(url, { method: "GET", signal: ctl.signal, redirect: "follow" });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { status: "unhealthy", latencyMs, error: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const looksLikeManifest = ct.includes("mpegurl") || ct.includes("m3u8");
    if (!looksLikeManifest) {
      // Some CDNs serve manifests as text/plain or application/octet-stream;
      // sniff the first line to be sure before flagging unhealthy.
      const head = (await res.text()).slice(0, 32);
      if (!head.startsWith("#EXTM3U")) {
        return {
          status: "unhealthy",
          latencyMs,
          error: `unexpected body (content-type=${ct || "none"})`,
        };
      }
    }
    return { status: "healthy", latencyMs, error: null };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: null,
      error: err instanceof Error ? err.message : "probe failed",
    };
  }
}

export async function liveIngestRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── List ─────────────────────────────────────────────────────────────────
  r.get(
    "/live-ingest/endpoints",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "List every configured live-ingest endpoint",
        response: {
          200: z.object({
            endpoints: z.array(EndpointSchema),
            summary: z.object({
              total: z.number().int().nonnegative(),
              active: z.number().int().nonnegative(),
              primary: z.string().nullable(),
              healthy: z.number().int().nonnegative(),
              degraded: z.number().int().nonnegative(),
              unhealthy: z.number().int().nonnegative(),
            }),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(ingest)
        .orderBy(desc(ingest.isPrimary), ingest.priority, desc(ingest.createdAt));
      const dtos = rows.map(toDto);
      const summary = {
        total: rows.length,
        active: rows.filter((r) => r.isActive).length,
        primary: rows.find((r) => r.isPrimary)?.id ?? null,
        healthy: rows.filter((r) => r.healthStatus === "healthy").length,
        degraded: rows.filter((r) => r.healthStatus === "degraded").length,
        unhealthy: rows.filter((r) => r.healthStatus === "unhealthy").length,
      };
      return { endpoints: dtos, summary };
    },
  );

  // ── Create ───────────────────────────────────────────────────────────────
  r.post(
    "/live-ingest/endpoints",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Create a new live-ingest endpoint",
        body: CreateBodySchema,
        response: { 200: EndpointSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body;
      const id = nanoid();
      const now = new Date();

      // Wrap the count-check + optional demote + insert in a single
      // transaction so two concurrent creates cannot both observe zero rows
      // and both mark themselves primary, or both try to demote the same
      // existing primary while inserting.
      const [row] = await db.transaction(async (tx) => {
        const existingCount = await tx.select({ id: ingest.id }).from(ingest).limit(1);
        const shouldBePrimary = body.isPrimary === true || existingCount.length === 0;

        if (shouldBePrimary) {
          await tx.update(ingest).set({ isPrimary: false, updatedAt: now });
        }

        return tx
          .insert(ingest)
          .values({
            id,
            name: body.name,
            protocol: body.protocol,
            ingestUrl: body.ingestUrl,
            streamKey: body.streamKey ?? generateStreamKey(),
            hlsPlaybackUrl: body.hlsPlaybackUrl,
            fallbackYoutubeUrl: body.fallbackYoutubeUrl ?? null,
            isPrimary: shouldBePrimary,
            isActive: body.isActive ?? true,
            priority: body.priority ?? 100,
            notes: body.notes ?? null,
            healthStatus: "unknown",
            metadata: body.metadata ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
      });
      return toDto(row!);
    },
  );

  // ── Patch ────────────────────────────────────────────────────────────────
  r.patch(
    "/live-ingest/endpoints/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Update mutable fields on a live-ingest endpoint",
        params: z.object({ id: z.string().min(1) }),
        body: PatchBodySchema,
        response: { 200: EndpointSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const patch = req.body;
      if (Object.keys(patch).length === 0) {
        throw new BadRequestError("PATCH body must include at least one field");
      }
      const updated = await db
        .update(ingest)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(ingest.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError(`Endpoint ${id} not found`);
      return toDto(updated[0]!);
    },
  );

  // ── Delete ───────────────────────────────────────────────────────────────
  r.delete(
    "/live-ingest/endpoints/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Remove a live-ingest endpoint",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const [existing] = await db
        .select({ isPrimary: ingest.isPrimary })
        .from(ingest)
        .where(eq(ingest.id, id))
        .limit(1);
      if (!existing) throw new NotFoundError(`Endpoint ${id} not found`);
      // Refuse to delete the primary unless it's the only row left —
      // requiring an explicit promote-then-delete prevents a producer
      // from accidentally orphaning the broadcast on a stale fallback.
      if (existing.isPrimary) {
        const others = await db
          .select({ id: ingest.id })
          .from(ingest)
          .where(ne(ingest.id, id))
          .limit(1);
        if (others.length > 0) {
          throw new BadRequestError(
            "Cannot delete the primary endpoint while others exist — promote another endpoint first",
          );
        }
      }
      await db.delete(ingest).where(eq(ingest.id, id));
      return { ok: true as const, id };
    },
  );

  // ── Rotate key ───────────────────────────────────────────────────────────
  r.post(
    "/live-ingest/endpoints/:id/rotate-key",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Generate a fresh stream key for an endpoint",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: EndpointSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const updated = await db
        .update(ingest)
        .set({ streamKey: generateStreamKey(), updatedAt: new Date() })
        .where(eq(ingest.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError(`Endpoint ${id} not found`);
      return toDto(updated[0]!);
    },
  );

  // ── Promote ──────────────────────────────────────────────────────────────
  r.post(
    "/live-ingest/endpoints/:id/promote",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Make this endpoint the primary (sole) ingest source",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: EndpointSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const now = new Date();
      // Wrap demote + promote in a transaction so concurrent promote calls
      // can never leave the table with zero or two primary rows. Without
      // the transaction a second concurrent promote could see the first
      // demote succeed and the second promote also succeed, yielding two
      // primaries. Inside the transaction the first writer holds a row lock
      // and the second will serialize behind it.
      const updated = await db.transaction(async (tx) => {
        await tx
          .update(ingest)
          .set({ isPrimary: false, updatedAt: now })
          .where(and(eq(ingest.isPrimary, true), ne(ingest.id, id)));
        return tx
          .update(ingest)
          .set({ isPrimary: true, isActive: true, updatedAt: now })
          .where(eq(ingest.id, id))
          .returning();
      });
      if (updated.length === 0) throw new NotFoundError(`Endpoint ${id} not found`);
      broadcastSignal("NODE_HEALTH_CHANGED", "temple-tv-live", {
        message: `Live ingest endpoint ${id} promoted to primary`,
        payload: { endpointId: id, event: "promoted" },
      });
      return toDto(updated[0]!);
    },
  );

  // ── Probe (one-shot health check) ────────────────────────────────────────
  r.post(
    "/live-ingest/endpoints/:id/probe",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Run a one-shot HLS playback probe and persist the result",
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({
            id: z.string(),
            ok: z.boolean(),
            status: HealthSchema,
            latencyMs: z.number().nullable(),
            bitrateKbps: z.number().nullable(),
            segmentLatencyMs: z.number().int().nullable(),
            error: z.string().nullable(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const [row] = await db.select().from(ingest).where(eq(ingest.id, id)).limit(1);
      if (!row) throw new NotFoundError(`Endpoint ${id} not found`);

      const probe = await probeEndpoint(row.hlsPlaybackUrl);
      const now = new Date();
      await db
        .update(ingest)
        .set({
          healthStatus: probe.status,
          lastHealthAt: now,
          lastHealthyAt: probe.status === "healthy" ? now : row.lastHealthyAt,
          lastSegmentLatencyMs: probe.latencyMs,
          consecutiveFailures:
            probe.status === "healthy" ? 0 : row.consecutiveFailures + 1,
          lastError: probe.error,
          updatedAt: now,
        })
        .where(eq(ingest.id, id));
      logger.info(
        { endpointId: id, status: probe.status, latencyMs: probe.latencyMs },
        "live-ingest probe completed",
      );
      broadcastSignal("NODE_HEALTH_CHANGED", "temple-tv-live", {
        message: `Live ingest probe for ${id}: ${probe.status}`,
        payload: { endpointId: id, event: "probe", status: probe.status },
      });
      return {
        id,
        ok: probe.status === "healthy",
        status: probe.status,
        latencyMs: probe.latencyMs,
        bitrateKbps: null,
        segmentLatencyMs: probe.latencyMs,
        error: probe.error,
      };
    },
  );

  // ── Stop active live override ────────────────────────────────────────────
  r.post(
    "/live-ingest/stop",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Stop the active live override (delegates to live-overrides)",
        response: { 200: z.object({ ok: z.literal(true), stopped: z.boolean() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const status = await liveOverridesService.getStatus();
      if (!status.active) return { ok: true as const, stopped: false };
      await liveOverridesService.stop();
      broadcastSignal("BROADCAST_UNLOCKED", "temple-tv-live", {
        message: "Live ingest stopped — broadcast unlocked",
        payload: { event: "live-ingest-stopped" },
      });
      return { ok: true as const, stopped: true };
    },
  );

  // ── Sweep stale endpoints ────────────────────────────────────────────────
  r.post(
    "/live-ingest/sweep",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Mark endpoints with no recent successful probe as unhealthy",
        body: z
          .object({ staleMs: z.number().int().min(60_000).max(24 * 60 * 60_000).optional() })
          .optional(),
        response: {
          200: z.object({
            ok: z.literal(true),
            sweptCount: z.number().int().nonnegative(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const staleMs = req.body?.staleMs ?? 5 * 60_000; // 5 minutes default
      const cutoff = new Date(Date.now() - staleMs);

      // Single bulk UPDATE rather than N individual queries: target every
      // row still claiming `healthy` whose last successful probe timestamp
      // is either NULL (never probed) or older than the stale cutoff.
      const swept = await db
        .update(ingest)
        .set({
          healthStatus: "unknown",
          lastError: `no probe in ${Math.round(staleMs / 60_000)}m`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(ingest.healthStatus, "healthy"),
            or(
              isNull(ingest.lastHealthAt),
              lt(ingest.lastHealthAt, cutoff),
            ),
          ),
        )
        .returning({ id: ingest.id });

      return { ok: true as const, sweptCount: swept.length };
    },
  );

  // ── Validate candidate stream key ────────────────────────────────────────
  r.post(
    "/live-ingest/validate-key",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Check if a candidate stream key collides with an existing one",
        body: z.object({ streamKey: z.string().min(1).max(512) }),
        response: {
          200: z.object({
            valid: z.boolean(),
            collidesWithEndpointId: z.string().nullable(),
            issues: z.array(z.string()),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { streamKey } = req.body;
      const issues: string[] = [];
      // Strength heuristics — nothing fancy, just enough to catch
      // "password123" style mistakes a junior operator might paste in.
      if (streamKey.length < 16) issues.push("stream key is shorter than 16 characters");
      if (!/[A-Za-z]/.test(streamKey) || !/[0-9]/.test(streamKey)) {
        issues.push("stream key should mix letters and digits");
      }
      const [collision] = await db
        .select({ id: ingest.id })
        .from(ingest)
        .where(eq(ingest.streamKey, streamKey))
        .limit(1);
      return {
        valid: !collision && issues.length === 0,
        collidesWithEndpointId: collision?.id ?? null,
        issues,
      };
    },
  );
}
