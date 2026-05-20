import { describe, it, expect } from "vitest";
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  TooManyRequestsError,
  InternalError,
  ServiceUnavailableError,
} from "../../src/shared/errors.js";

describe("AppError hierarchy", () => {
  it("AppError sets statusCode, code, and message", () => {
    const err = new AppError(418, "TEAPOT", "I am a teapot", { hint: "brew coffee" });
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe("TEAPOT");
    expect(err.message).toBe("I am a teapot");
    expect(err.details).toEqual({ hint: "brew coffee" });
    expect(err).toBeInstanceOf(Error);
  });

  it("BadRequestError is 400 BAD_REQUEST", () => {
    const err = new BadRequestError("bad input");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err).toBeInstanceOf(AppError);
  });

  it("UnauthorizedError is 401 UNAUTHORIZED", () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
  });

  it("ForbiddenError is 403 FORBIDDEN", () => {
    const err = new ForbiddenError("Requires role: admin");
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("admin");
  });

  it("NotFoundError is 404 NOT_FOUND", () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("ConflictError is 409 CONFLICT", () => {
    const err = new ConflictError("Email already taken", { field: "email" });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toEqual({ field: "email" });
  });

  it("TooManyRequestsError is 429 RATE_LIMITED", () => {
    const err = new TooManyRequestsError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("InternalError is 500 INTERNAL", () => {
    const err = new InternalError("unexpected failure");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("INTERNAL");
  });

  it("ServiceUnavailableError is 503 SERVICE_UNAVAILABLE", () => {
    const err = new ServiceUnavailableError();
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("all error subclasses are instanceof AppError and Error", () => {
    const errors = [
      new BadRequestError(),
      new UnauthorizedError(),
      new ForbiddenError(),
      new NotFoundError(),
      new ConflictError(),
      new TooManyRequestsError(),
      new InternalError(),
      new ServiceUnavailableError(),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
