import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  process.env.JWT_ACCESS_SECRET = "x".repeat(64);
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
});

describe("jwt", () => {
  it("signs and verifies an access token", async () => {
    const { signAccessToken, verifyAccessToken } = await import("../../src/modules/auth/jwt.js");
    const token = signAccessToken({ sub: "u-1", email: "a@b.com", role: "user" });
    expect(token).toMatch(/^eyJ/);
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe("u-1");
    expect(decoded.email).toBe("a@b.com");
    expect(decoded.role).toBe("user");
    expect(decoded.type).toBe("access");
  });

  it("rejects a token signed with the refresh secret as access", async () => {
    const { signRefreshToken, verifyAccessToken } = await import("../../src/modules/auth/jwt.js");
    const token = signRefreshToken({ sub: "u-1", jti: "abc" });
    expect(() => verifyAccessToken(token)).toThrow(/Invalid|Wrong/);
  });
});

describe("rbac", () => {
  it("ranks roles correctly", async () => {
    const { hasRole } = await import("../../src/modules/auth/rbac.js");
    expect(hasRole("admin", "user")).toBe(true);
    expect(hasRole("editor", "admin")).toBe(false);
    expect(hasRole(undefined, "user")).toBe(false);
    expect(hasRole("system", "admin")).toBe(true);
  });

  it("requireRole throws ForbiddenError for insufficient role", async () => {
    const { requireRole } = await import("../../src/modules/auth/rbac.js");
    const { ForbiddenError } = await import("../../src/shared/errors.js");
    expect(() => requireRole("user", "admin")).toThrow(ForbiddenError);
  });
});
