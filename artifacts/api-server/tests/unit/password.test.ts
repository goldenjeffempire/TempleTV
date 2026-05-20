import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  process.env.JWT_ACCESS_SECRET = "x".repeat(64);
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
  // Use a low round count in tests so hashing completes in < 100 ms.
  process.env.BCRYPT_ROUNDS = "4";
});

describe("password", () => {
  it("hashPassword produces a bcrypt hash starting with $2", async () => {
    const { hashPassword } = await import("../../src/modules/auth/password.js");
    const hash = await hashPassword("TempleTV@2026!");
    expect(hash).toMatch(/^\$2[ab]\$/);
  });

  it("verifyPassword returns true for the correct plain-text password", async () => {
    const { hashPassword, verifyPassword } = await import("../../src/modules/auth/password.js");
    const hash = await hashPassword("TempleTV@2026!");
    expect(await verifyPassword("TempleTV@2026!", hash)).toBe(true);
  });

  it("verifyPassword returns false for a wrong password", async () => {
    const { hashPassword, verifyPassword } = await import("../../src/modules/auth/password.js");
    const hash = await hashPassword("TempleTV@2026!");
    expect(await verifyPassword("WrongPassword!", hash)).toBe(false);
  });

  it("two hashes of the same password differ (bcrypt salting)", async () => {
    const { hashPassword } = await import("../../src/modules/auth/password.js");
    const [h1, h2] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);
    expect(h1).not.toBe(h2);
  });

  it("verifyPassword returns false for an empty string against a real hash", async () => {
    const { hashPassword, verifyPassword } = await import("../../src/modules/auth/password.js");
    const hash = await hashPassword("TempleTV@2026!");
    expect(await verifyPassword("", hash)).toBe(false);
  });
});
