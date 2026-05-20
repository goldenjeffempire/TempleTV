import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

/**
 * Client crash report schema.
 *
 * All four surfaces (web, TV, mobile, admin) POST to `/api/client-errors`.
 * The schema is intentionally lenient on optional fields — not every client
 * has every piece of context available (e.g., TV has no appVersion; web has
 * no buildNumber). Missing fields are simply omitted from the log entry.
 *
 * Alignment notes:
 *   - `appVersion` / `buildNumber`: sent by the mobile errorReporter.ts
 *     (Expo `Constants.expoConfig.version` and `versionCode`). Previously
 *     these were stripped by Zod because they weren't declared here — now
 *     they land in the log and are surfaced in Sentry breadcrumbs so
 *     operators can correlate crashes with specific release builds.
 *   - `context` uses `.passthrough()` so undeclared fields (e.g., a future
 *     `buildVariant` or `deviceModel` key) are forwarded to the log sink
 *     rather than dropped. We accept the mild schema looseness here because
 *     the context object is never stored in a DB — it's purely for logging.
 */
const ClientErrorSchema = z.object({
  platform: z.enum(["web", "tv", "mobile", "admin"]),
  /**
   * Semantic version string from the app's package.json / Expo config.
   * Mobile: `Constants.expoConfig.version` (e.g. "1.4.2").
   * TV / web: `process.env.APP_VERSION` if set, otherwise omitted.
   */
  appVersion: z.string().max(32).optional(),
  /**
   * Platform-specific build identifier.
   * Android: `versionCode` (integer as string, e.g. "42").
   * iOS: `CFBundleVersion` (e.g. "42").
   * Web / TV: omitted.
   */
  buildNumber: z.string().max(32).optional(),
  errorName: z.string().max(256),
  errorMessage: z.string().max(4096),
  stack: z.string().max(16_384).optional(),
  componentStack: z.string().max(16_384).optional(),
  context: z
    .object({
      url: z.string().max(2048).optional(),
      userAgent: z.string().max(1024).optional(),
      source: z.string().max(64).optional(),
    })
    .passthrough()
    .optional(),
  occurredAt: z.string().datetime(),
});

const AckSchema = z.object({
  ok: z.literal(true),
  receivedAt: z.string(),
});

export async function telemetryRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Client crash reports from web / TV / mobile / admin error boundaries.
  // The endpoints all four surfaces POST to ends here. Logged through the
  // shared Fastify pino logger so reports flow into the same pipeline as
  // request logs (and Sentry via the breadcrumb integration in
  // `instrument.mjs`); no DB write — these are firehose events.
  r.post(
    "/client-errors",
    {
      config: {
        // Low limit: each client should POST at most once per caught error,
        // and genuine error storms are rare. 10 req/min/IP blocks abuse
        // (bots bulk-posting large payloads) while never affecting real
        // clients during even a severe crash loop.
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["telemetry"],
        summary: "Ingest a client-side crash report",
        body: ClientErrorSchema,
        response: { 202: AckSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;
      req.log.warn(
        {
          clientError: {
            platform: body.platform,
            appVersion: body.appVersion,
            buildNumber: body.buildNumber,
            errorName: body.errorName,
            errorMessage: body.errorMessage,
            url: body.context?.url,
            userAgent: body.context?.userAgent,
            occurredAt: body.occurredAt,
          },
          // F38: include the Fastify request ID so this log entry can be
          // correlated with the surrounding access log by searching for
          // the same reqId value across both log lines.
          reqId: req.id,
          // Stack and componentStack are large and noisy; emit them as
          // separate fields so log shippers can drop them at the edge.
          stack: body.stack,
          componentStack: body.componentStack,
        },
        `[client-error:${body.platform}${body.appVersion ? `@${body.appVersion}` : ""}] ${body.errorName}: ${body.errorMessage}`,
      );
      reply.code(202);
      return { ok: true as const, receivedAt: new Date().toISOString() };
    },
  );
}
