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
