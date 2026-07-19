/**
 * All HTTP errors thrown from services/routes inherit from `AppError`.
 * The global error handler maps them to RFC 7807-style responses.
 */
export declare class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly details?: unknown;
    constructor(statusCode: number, code: string, message: string, details?: unknown);
}
export declare class BadRequestError extends AppError {
    constructor(message?: string, details?: unknown);
}
export declare class UnauthorizedError extends AppError {
    constructor(message?: string);
}
export declare class ForbiddenError extends AppError {
    constructor(message?: string);
}
export declare class NotFoundError extends AppError {
    constructor(message?: string);
}
export declare class ConflictError extends AppError {
    constructor(message?: string, details?: unknown);
}
export declare class UnprocessableEntityError extends AppError {
    constructor(message?: string, details?: unknown);
}
export declare class TooManyRequestsError extends AppError {
    constructor(message?: string);
}
export declare class InternalError extends AppError {
    constructor(message?: string, details?: unknown);
}
export declare class BadGatewayError extends AppError {
    constructor(message?: string, details?: unknown);
}
export declare class ServiceUnavailableError extends AppError {
    constructor(message?: string, details?: unknown);
}
export declare class GatewayTimeoutError extends AppError {
    constructor(message?: string, details?: unknown);
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
export declare function classifyError(err: unknown, context?: string): AppError;
