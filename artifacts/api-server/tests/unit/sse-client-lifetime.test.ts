import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  bindSseClientLifetime,
  writeSseChunk,
  writeSseHeaders,
} from "../../src/modules/broadcast-v2/io/sse-client-lifetime.js";

test("raw SSE preserves approved CORS and security headers without reflecting unapproved origins", async () => {
  const app = Fastify();
  await app.register(cors, {
    origin: ["https://admin.templetv.org.ng"],
    credentials: true,
  });
  app.get("/events", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-length", "0");
    writeSseHeaders(reply, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "content-encoding": "identity",
    });
    reply.raw.end('retry: 5000\n\nevent: hello\ndata: {"type":"hello"}\n\n');
  });
  try {
    const allowed = await app.inject({
      method: "GET",
      url: "/events",
      headers: { origin: "https://admin.templetv.org.ng" },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], "https://admin.templetv.org.ng");
    assert.equal(allowed.headers["access-control-allow-credentials"], "true");
    assert.match(String(allowed.headers.vary), /origin/i);
    assert.equal(allowed.headers["x-content-type-options"], "nosniff");
    assert.equal(allowed.headers["content-length"], undefined);
    assert.match(allowed.body, /event: hello/);
    const denied = await app.inject({
      method: "GET",
      url: "/events",
      headers: { origin: "https://unapproved.invalid" },
    });
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

test("completed GET does not abort SSE; response disconnect does", () => {
  const request = new EventEmitter() as IncomingMessage;
  const response = new EventEmitter() as ServerResponse;
  const lifetime = bindSseClientLifetime(request, response);
  request.emit("close");
  assert.equal(lifetime.controller.signal.aborted, false);
  response.emit("close");
  assert.equal(lifetime.controller.signal.aborted, true);
  lifetime.cleanup();
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(request.listenerCount("aborted"), 0);
});

test("backpressure waits for drain and preserves every chunk", async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  const chunks: Buffer[] = [];
  const controller = new AbortController();
  const write = writeSseChunk(stream as unknown as ServerResponse, "data: first\n\n", controller.signal);
  let settled = false;
  void write.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false);
  stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
  assert.equal(await write, true);
  assert.equal(await writeSseChunk(stream as unknown as ServerResponse, "data: second\n\n", controller.signal), true);
  assert.equal(Buffer.concat(chunks).toString(), "data: first\n\ndata: second\n\n");
  assert.equal(stream.listenerCount("drain"), 0);
  stream.destroy();
});

test("disconnect while waiting for drain stops the writer and removes listeners", async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  const controller = new AbortController();
  const write = writeSseChunk(stream as unknown as ServerResponse, "data: message\n\n", controller.signal);
  controller.abort();
  assert.equal(await write, false);
  assert.equal(stream.listenerCount("drain"), 0);
  assert.equal(stream.listenerCount("close"), 0);
  stream.destroy();
});

test("real HTTP SSE survives request completion and detects client cancellation", async () => {
  let disconnected!: () => void;
  const disconnectedPromise = new Promise<void>(resolve => { disconnected = resolve; });
  let prematureAbort = false;
  const server = createServer((request, response) => {
    const lifetime = bindSseClientLifetime(request, response);
    lifetime.controller.signal.addEventListener("abort", () => {
      lifetime.cleanup();
      disconnected();
    }, { once: true });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    request.resume();
    const timer = setTimeout(() => {
      prematureAbort = lifetime.controller.signal.aborted;
      response.write("data: second\n\n");
    }, 40);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/events`, {
      signal: AbortSignal.timeout(3_000),
    });
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes("second")) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      received += new TextDecoder().decode(value);
    }
    assert.equal(prematureAbort, false);
    assert.ok(received.includes("first"));
    await reader.cancel();
    await Promise.race([
      disconnectedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("disconnect not observed")), 1_000).unref()),
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
