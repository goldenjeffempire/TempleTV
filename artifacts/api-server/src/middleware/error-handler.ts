import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError, BadGatewayError, GatewayTimeoutError, InternalError } from "../shared/errors.js";
import { captureException } from "../infrastructure/sentry.js";

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  // Included on all 4xx/5xx responses so routes whose response schema declares
  // `{ error: z.string() }` (the common shorthand for error routes) pass
  // Fastify's Zod serializer without a ResponseSerializationError.
  // Without this field, every rate-limit (429) and auth (401) response was
  // serialised as a 500 because the serializer saw `error: undefined`.
  error?: string;
  detail?: string;
  errors?: unknown;
  requestId: string;
}

/**
 * Classify a raw caught error into the closest AppError subclass so the
 * error handler can emit an appropriate HTTP status code instead of a
 * generic 500.  Classification is done by inspecting the Node error code
 * (ECONNREFUSED, ETIMEDOUT, etc.) and the error name (AbortError,
 * TimeoutError).  This prevents upstream network failures from appearing
 * as 500 Internal Server Errors on monitoring dashboards.
 */
function classifyRawError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;

  const e = err as { name?: string; code?: string; message?: string };
  const name = e?.name ?? "";
  const code = e?.code ?? "";

  // Abort / timeout from AbortSignal.timeout() or fetch() cancellation
  if (name === "AbortError" || name === "TimeoutError") {
    return new GatewayTimeoutError("Upstream service did not respond in time");
  }
  // Node.js network error codes
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNABORTED") {
    return new GatewayTimeoutError("Connection to upstream service timed out");
  }
  if (
    code === "ECONNREFUSED" || code === "ECONNRESET" ||
    code === "ENOTFOUND" || code === "EAI_AGAIN" ||
    code === "EHOSTUNREACH" || code === "ENETUNREACH"
  ) {
    return new BadGatewayError("Upstream service is unreachable");
  }
  // PostgreSQL connection errors surfaced by the `pg` driver
  if (code === "ECONNRESET" || code === "CONNECTION_RESET") {
    return new InternalError("Database connection reset — retry momentarily");
  }
  // Postgres driver terminates with "Connection terminated unexpectedly"
  if (e?.message?.includes("Connection terminated")) {
    return new InternalError("Database connection lost — retry momentarily");
  }

  return null;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;

    // ── 1. Zod validation errors (request body / params / query) ─────────────
    if (err instanceof ZodError) {
      const sanitizedErrors = err.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.length > 0 ? issue.path.join(".") : undefined,
      }));
      const body: ProblemDetails = {
        type: "https://templetv.api/errors/validation",
        title: "Validation failed",
        status: 400,
        code: "VALIDATION_ERROR",
        error: "Validation failed",
        errors: sanitizedErrors,
        requestId,
      };
      return reply.code(400).send(body);
    }

    // ── 2. Classify raw network / timeout errors before treating as 500 ───────
    const classified = classifyRawError(err);
    if (classified) {
      req.log.warn({ err, classified: { statusCode: classified.statusCode, code: classified.code } }, "classified upstream error");
      const body: ProblemDetails = {
        type: `https://templetv.api/errors/${classified.code.toLowerCase()}`,
        title: classified.message,
        status: classified.statusCode,
        code: classified.code,
        error: classified.message,
        detail: classified.message,
        requestId,
      };
      return reply.code(classified.statusCode).send(body);
    }

    // ── 3. AppError (BadRequestError, NotFoundError, ConflictError, etc.) ─────
    if (err instanceof AppError) {
      const body: ProblemDetails = {
        type: `https://templetv.api/errors/${err.code.toLowerCase()}`,
        title: err.message,
        status: err.statusCode,
        code: err.code,
        error: err.message,
        detail: err.message,
        errors: err.details,
        requestId,
      };
      return reply.code(err.statusCode).send(body);
    }

    // ── 4. Fastify built-in errors (rate-limit 429, auth 401, etc.) ───────────
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) {
      req.log.error(
        {
          err,
          requestId,
          method: req.method,
          route: (req.routeOptions as { url?: string } | undefined)?.url ?? req.url,
          userId: req.principal?.id,
          userRole: req.principal?.role,
          durationMs: Math.round(reply.elapsedTime ?? 0),
        },
        "unhandled 500 error",
      );
      void captureException(err, {
        requestId,
        userId: req.principal?.id,
        userRole: req.principal?.role,
        method: req.method,
        path: (req.routeOptions as { url?: string } | undefined)?.url ?? req.url,
      });
    } else {
      req.log.warn({ err: { message: err.message, name: err.name, code: (err as FastifyError).code } }, "client error");
    }

    // Never leak the raw Fastify/Node `err.code` on 500 — some libraries
    // ship error codes that reveal internal state (PG codes, fs paths in
    // SQLite error codes, fetch URLs in undici errors). Use a generic
    // constant so external monitors get a stable signal without data leak.
    const body: ProblemDetails = {
      type: "https://templetv.api/errors/internal",
      title: status >= 500 ? "Internal server error" : err.message,
      status,
      code: status >= 500 ? "INTERNAL" : ((err as FastifyError).code ?? "INTERNAL"),
      // `error` satisfies route response schemas that declare `{ error: z.string() }`
      // (used for both 4xx and 5xx responses). Without it Fastify's Zod serializer
      // rejects the response and escalates to a ResponseSerializationError that
      // surfaces as a second "Internal Server Error" with no useful diagnostics.
      error: status >= 500 ? "Internal server error" : err.message,
      detail: status >= 500 ? undefined : err.message,
      requestId,
    };
    return reply.code(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      type: "https://templetv.api/errors/not_found",
      title: "Route not found",
      status: 404,
      code: "ROUTE_NOT_FOUND",
      error: "Route not found",
      detail: `${req.method} ${req.url}`,
      requestId: req.id,
    });
  });
}
