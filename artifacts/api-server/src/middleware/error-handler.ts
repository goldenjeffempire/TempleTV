import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../shared/errors.js";

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: unknown;
  requestId: string;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;

    if (err instanceof ZodError) {
      const body: ProblemDetails = {
        type: "https://templetv.api/errors/validation",
        title: "Validation failed",
        status: 400,
        code: "VALIDATION_ERROR",
        errors: err.issues,
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
        detail: err.message,
        errors: err.details,
        requestId,
      };
      return reply.code(err.statusCode).send(body);
    }

    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
    } else {
      req.log.warn({ err: { message: err.message, name: err.name } }, "client error");
    }
    const body: ProblemDetails = {
      type: "https://templetv.api/errors/internal",
      title: status >= 500 ? "Internal server error" : err.message,
      status,
      code: (err as FastifyError).code ?? "INTERNAL",
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
