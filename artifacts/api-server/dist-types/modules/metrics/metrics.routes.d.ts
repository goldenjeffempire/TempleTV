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
export declare function metricsRoutes(app: FastifyInstance): Promise<void>;
