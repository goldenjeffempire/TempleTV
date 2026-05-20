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
export declare class TooManyRequestsError extends AppError {
    constructor(message?: string);
}
export declare class InternalError extends AppError {
    constructor(message?: string, details?: unknown);
}
export declare class ServiceUnavailableError extends AppError {
    constructor(message?: string, details?: unknown);
}
