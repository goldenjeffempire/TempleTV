import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../shared/errors.js";
import { captureException } from "../infrastructure/sentry.js";

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  // Included on all 4xx responses so routes whose response schema declares
  // `{ error: z.string() }` (the common shorthand for error routes) pass
  // Fastify's Zod serializer without a ResponseSerializationError.
  // Without this field, every rate-limit (429) and auth (401) response was
  // serialised as a 500 because the serializer saw `error: undefined`.
  error?: string;
  detail?: string;
  errors?: unknown;
  requestId: string;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;

    if (err instanceof ZodError) {
      // Sanitize: only expose the human-readable message and the field path.
      // Never send `code`, `expected`, `received`, `unionErrors`, or other
      // Zod internals — they reveal internal schema structure to callers.
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

    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
      // Report to Sentry with request context so errors are traceable to a
      // specific user, endpoint, and request ID without leaking PII beyond
      // what is already in the Sentry project's data-scrubbing rules.
      void captureException(err, {
        requestId,
        userId: req.principal?.id,
        userRole: req.principal?.role,
        method: req.method,
        path: req.routeOptions?.url ?? req.url,
      });
    } else {
      req.log.warn({ err: { message: err.message, name: err.name } }, "client error");
    }
    // Never leak the raw Fastify/Node `err.code` on 500 — some libraries
    // ship error codes that reveal internal state (PG codes, fs paths in
    // SQLite codes, fetch URLs in undici codes). Use a generic constant
    // so external monitors get a stable signal without information leak.
    const body: ProblemDetails = {
      type: "https://templetv.api/errors/internal",
      title: status >= 500 ? "Internal server error" : err.message,
      status,
      code: status >= 500 ? "INTERNAL" : ((err as FastifyError).code ?? "INTERNAL"),
      // `error` satisfies route response schemas that declare `{ error: z.string() }`
      // (the shorthand used for 4xx responses across many routes). Without it,
      // Fastify's Zod serializer rejects the response and escalates to a 500
      // ResponseSerializationError — turning every 429 rate-limit into a 500.
      error: status < 500 ? err.message : undefined,
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
      detail: `${req.method} ${req.url}`,
      requestId: req.id,
    });
  });
}
