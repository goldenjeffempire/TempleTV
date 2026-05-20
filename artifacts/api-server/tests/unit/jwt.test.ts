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
    const token = await signAccessToken({ sub: "u-1", email: "a@b.com", role: "user" });
    expect(token).toMatch(/^eyJ/);
    const decoded = await verifyAccessToken(token);
    expect(decoded.sub).toBe("u-1");
    expect(decoded.email).toBe("a@b.com");
    expect(decoded.role).toBe("user");
    expect(decoded.type).toBe("access");
  });

  it("signs and verifies a refresh token", async () => {
    const { signRefreshToken, verifyRefreshToken } = await import("../../src/modules/auth/jwt.js");
    const token = await signRefreshToken({ sub: "u-2", jti: "jti-abc" });
    expect(token).toMatch(/^eyJ/);
    const decoded = await verifyRefreshToken(token);
    expect(decoded.sub).toBe("u-2");
    expect(decoded.jti).toBe("jti-abc");
    expect(decoded.type).toBe("refresh");
  });

  it("rejects a refresh token presented as an access token", async () => {
    const { signRefreshToken, verifyAccessToken } = await import("../../src/modules/auth/jwt.js");
    const token = await signRefreshToken({ sub: "u-1", jti: "abc" });
    await expect(verifyAccessToken(token)).rejects.toThrow(/Invalid|Wrong/);
  });

  it("rejects an access token presented as a refresh token", async () => {
    const { signAccessToken, verifyRefreshToken } = await import("../../src/modules/auth/jwt.js");
    const token = await signAccessToken({ sub: "u-1", email: "a@b.com", role: "admin" });
    await expect(verifyRefreshToken(token)).rejects.toThrow(/Invalid|Wrong/);
  });

  it("rejects a token signed with `none` algorithm (alg-confusion guard)", async () => {
    const { verifyAccessToken } = await import("../../src/modules/auth/jwt.js");
    // Build a JWT manually with alg:none — no crypto library needed.
    // This simulates a classic alg-confusion attack where an attacker strips
    // the signature and changes the algorithm to "none".
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "u-1", email: "a@b.com", role: "admin", type: "access" }),
    ).toString("base64url");
    const forged = `${header}.${payload}.`;
    await expect(verifyAccessToken(forged)).rejects.toThrow(/Invalid|expired/);
  });

  it("rejects a structurally invalid token (garbage string)", async () => {
    const { verifyAccessToken } = await import("../../src/modules/auth/jwt.js");
    await expect(verifyAccessToken("not.a.jwt")).rejects.toThrow(/Invalid|expired/);
  });

  it("rejects an empty string as a token", async () => {
    const { verifyAccessToken } = await import("../../src/modules/auth/jwt.js");
    await expect(verifyAccessToken("")).rejects.toThrow(/Invalid|expired/);
  });
});

describe("rbac", () => {
  it("ranks roles correctly (user < editor < admin < system)", async () => {
    const { hasRole } = await import("../../src/modules/auth/rbac.js");
    expect(hasRole("admin", "user")).toBe(true);
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("editor", "admin")).toBe(false);
    expect(hasRole("user", "editor")).toBe(false);
    expect(hasRole("system", "admin")).toBe(true);
    expect(hasRole("system", "system")).toBe(true);
    expect(hasRole(undefined, "user")).toBe(false);
  });

  it("requireRole passes when role is sufficient", async () => {
    const { requireRole } = await import("../../src/modules/auth/rbac.js");
    expect(() => requireRole("admin", "editor")).not.toThrow();
    expect(() => requireRole("system", "user")).not.toThrow();
  });

  it("requireRole throws ForbiddenError for insufficient role", async () => {
    const { requireRole } = await import("../../src/modules/auth/rbac.js");
    const { ForbiddenError } = await import("../../src/shared/errors.js");
    expect(() => requireRole("user", "admin")).toThrow(ForbiddenError);
    expect(() => requireRole("editor", "admin")).toThrow(ForbiddenError);
  });

  it("requireRole throws UnauthorizedError when role is undefined", async () => {
    const { requireRole } = await import("../../src/modules/auth/rbac.js");
    const { UnauthorizedError } = await import("../../src/shared/errors.js");
    expect(() => requireRole(undefined, "user")).toThrow(UnauthorizedError);
  });
});
