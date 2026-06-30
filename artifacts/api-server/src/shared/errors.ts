/**
 * All HTTP errors thrown from services/routes inherit from `AppError`.
 * The global error handler maps them to RFC 7807-style responses.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(400, "BAD_REQUEST", message, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message);
  }
}
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}
export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}
export class UnprocessableEntityError extends AppError {
  constructor(message = "Unprocessable entity", details?: unknown) {
    super(422, "UNPROCESSABLE_ENTITY", message, details);
  }
}
export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests") {
    super(429, "RATE_LIMITED", message);
  }
}
export class InternalError extends AppError {
  constructor(message = "Internal server error", details?: unknown) {
    super(500, "INTERNAL", message, details);
  }
}
export class BadGatewayError extends AppError {
  constructor(message = "Bad gateway — upstream service error", details?: unknown) {
    super(502, "BAD_GATEWAY", message, details);
  }
}
export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", details?: unknown) {
    super(503, "SERVICE_UNAVAILABLE", message, details);
  }
}
export class GatewayTimeoutError extends AppError {
  constructor(message = "Gateway timeout — upstream did not respond in time", details?: unknown) {
    super(504, "GATEWAY_TIMEOUT", message, details);
  }
}

/**
 * Wraps an unknown caught value into the closest AppError subclass.
 * Use in catch blocks to get a structured error without leaking raw
 * node error codes (ECONNREFUSED, ETIMEDOUT, etc.) to the client.
 *
 * Classification rules:
 *   • Already an AppError → returned as-is.
 *   • AbortError / TimeoutError → 504 GatewayTimeout
 *   • ECONNREFUSED / ENOTFOUND / EAI_AGAIN (DNS) → 502 BadGateway
 *   • ETIMEDOUT / ESOCKETTIMEDOUT → 504 GatewayTimeout
 *   • Everything else → 500 InternalError (message logged server-side only)
 */
export function classifyError(err: unknown, context?: string): AppError {
  if (err instanceof AppError) return err;

  const e = err as { name?: string; code?: string; message?: string };
  const name = e?.name ?? "";
  const code = e?.code ?? "";
  const msg  = e?.message ?? String(err);

  if (name === "AbortError" || name === "TimeoutError") {
    return new GatewayTimeoutError(context ? `${context}: timed out` : "Request timed out");
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNABORTED") {
    return new GatewayTimeoutError(context ? `${context}: timed out` : "Connection timed out");
  }
  if (
    code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND" ||
    code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH"
  ) {
    return new BadGatewayError(context ? `${context}: upstream unreachable` : "Upstream service unreachable");
  }

  return new InternalError(context ?? msg);
}
