import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const ClientErrorSchema = z.object({
  platform: z.enum(["web", "tv", "mobile", "admin"]),
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
      schema: {
        tags: ["telemetry"],
        summary: "Ingest a client-side crash report",
        body: ClientErrorSchema,
        response: { 202: AckSchema },
      },
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof ClientErrorSchema>;
      req.log.warn(
        {
          clientError: {
            platform: body.platform,
            errorName: body.errorName,
            errorMessage: body.errorMessage,
            url: body.context?.url,
            userAgent: body.context?.userAgent,
            occurredAt: body.occurredAt,
          },
          // Stack and componentStack are large and noisy; emit them as
          // separate fields so log shippers can drop them at the edge.
          stack: body.stack,
          componentStack: body.componentStack,
        },
        `[client-error:${body.platform}] ${body.errorName}: ${body.errorMessage}`,
      );
      reply.code(202);
      return { ok: true as const, receivedAt: new Date().toISOString() };
    },
  );
}
