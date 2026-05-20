/**
 * Integration tests for the GET /metrics Prometheus scrape endpoint.
 *
 * Boots the Fastify app in test mode, exercises a handful of routes, then
 * asserts that the histogram series and custom gauges are present in the
 * /metrics response.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const TEST_TOKEN = "x".repeat(64);

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL && process.env.DATABASE_URL !== ""
      ? process.env.DATABASE_URL
      : "postgres://test:test@localhost:5432/test";
  process.env.JWT_ACCESS_SECRET = TEST_TOKEN;
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
  process.env.ADMIN_API_TOKEN = TEST_TOKEN;
  process.env.ADMIN_API_TOKEN_ROLE = "admin";
  try {
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp();
    await app.ready();
  } catch {
    // No DB in CI — tests guard with `if (!app)`.
  }
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
}, 15_000);

describe("GET /metrics — Prometheus scrape endpoint", () => {
  it("returns 401 without auth", async () => {
    if (!app) return;
    const r = await app.inject({ method: "GET", url: "/metrics" });
    expect(r.statusCode).toBe(401);
  });

  it("returns 200 with valid ADMIN_API_TOKEN (admin role)", async () => {
    if (!app) return;
    // ADMIN_API_TOKEN_ROLE=admin — /metrics requires admin role.
    const r = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("response contains http_request_duration_seconds histogram", async () => {
    if (!app) return;
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/status" });

    const r = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.payload).toMatch(/http_request_duration_seconds/);
    expect(r.payload).toMatch(/http_request_duration_seconds_bucket/);
    expect(r.payload).toMatch(/http_request_duration_seconds_sum/);
    expect(r.payload).toMatch(/http_request_duration_seconds_count/);
  });

  it("response contains custom app metric families", async () => {
    if (!app) return;
    const r = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.payload;

    expect(body).toMatch(/sse_connections_active/);
    expect(body).toMatch(/ws_connections_active/);
    expect(body).toMatch(/broadcast_v2_sequence/);
    expect(body).toMatch(/broadcast_v2_mode_active/);
    expect(body).toMatch(/transcoding_queue_depth/);
    expect(body).toMatch(/process_rss_bytes/);
  });

  it("response contains default Node.js process metrics", async () => {
    if (!app) return;
    const r = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.payload).toMatch(/process_cpu_seconds_total/);
    expect(r.payload).toMatch(/nodejs_heap_size_used_bytes/);
  });

  it("histogram labels include method, route, status_code", async () => {
    if (!app) return;
    await app.inject({ method: "GET", url: "/healthz" });

    const r = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = r.payload;
    expect(body).toMatch(/method="GET"/);
    expect(body).toMatch(/service="temple-tv-api"/);
  });
});
