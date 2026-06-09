/**
 * GET /metrics — Prometheus text-format scrape endpoint.
 *
 * Protected by requireAuth("admin") so the scrape endpoint is only reachable
 * with a valid admin JWT session or the ADMIN_API_TOKEN bearer configured
 * with ADMIN_API_TOKEN_ROLE=admin.  Prometheus scrapers should pass the token
 * via `Authorization: Bearer <ADMIN_API_TOKEN>`.
 *
 * Response merges two registries:
 *   1. promRegistry  — custom app metrics + default Node.js metrics (prom-client)
 *   2. OTel registry — auto-instrumentation metrics from the OpenTelemetry SDK
 *      (initialised in instrument.ts, exposed via globalThis.__otelPrometheusExporter)
 *
 * The global @fastify/rate-limit (registered in app.ts) covers this route;
 * no additional rate-limit plugin registration is needed here.
 *
 * Returns 401 for unauthenticated requests and 403 for insufficient role.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { promRegistry } from "../../infrastructure/metrics.js";

/** Collect Prometheus text from the OTel PrometheusExporter (if initialised). */
async function collectOtelMetrics(): Promise<string> {
  const exporter = (globalThis as Record<string, unknown>)
    .__otelPrometheusExporter as
    | { getMetricsRequestHandler?: (req: unknown, res: unknown) => void }
    | undefined;
  if (!exporter?.getMetricsRequestHandler) return "";
  return new Promise<string>((resolve) => {
    const mockRes = {
      setHeader: () => {},
      end: (body: string) => resolve(body ?? ""),
      statusCode: 200,
    };
    try {
      exporter.getMetricsRequestHandler!({}, mockRes);
    } catch {
      resolve("");
    }
  });
}

export async function metricsRoutes(app: FastifyInstance) {
  app.get(
    "/metrics",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { response: { 200: z.unknown(), 429: z.object({ error: z.string() }) } },
    },
    async (_req, reply) => {
      const [customMetrics, otelMetrics] = await Promise.all([
        promRegistry.metrics(),
        collectOtelMetrics(),
      ]);
      const body = otelMetrics
        ? `${customMetrics}\n${otelMetrics}`
        : customMetrics;
      return reply
        .status(200)
        .header("Content-Type", promRegistry.contentType)
        .send(body);
    },
  );
}
