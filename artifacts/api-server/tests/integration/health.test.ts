import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
  process.env.JWT_ACCESS_SECRET = "x".repeat(64);
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
  const { buildApp } = await import("../../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("/healthz", () => {
  it("returns 200 ok", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "ok" });
  });
});

describe("/", () => {
  it("returns service banner", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ service: "temple-tv-api", api: "/api/v1" });
  });
});

describe("/api/v1/broadcast/current", () => {
  it("returns a snapshot", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/broadcast/current" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ channelId: "temple-tv-live" });
  });
});
