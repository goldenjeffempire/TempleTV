import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedChunks, STORAGE_READ_CHUNK_BYTES as cap } from "../../src/infrastructure/bounded-chunk-reader.js";
import { assertStorageReadAdmission, pauseStorageReadAdmission } from "../../src/infrastructure/storage-read-admission.js";

test("full multipart reads transfer at most 4 MiB per query", async () => {
  const calls: number[] = [];
  let bytes = 0;
  for await (const data of readBoundedChunks(
    [{ chunk_index: 1, size_bytes: cap * 4 }, { chunk_index: 2, size_bytes: 7 }],
    0, Number.MAX_SAFE_INTEGER,
    async (_index, _offset, length) => { calls.push(length); return Buffer.alloc(length); },
    () => false,
  )) bytes += data.length;
  assert.equal(bytes, cap * 4 + 7);
  assert.deepEqual(calls, [cap, cap, cap, cap, 7]);
});

test("two-byte probe does not fetch or retain an entire 16 MiB row", async () => {
  const calls: unknown[] = [];
  for await (const data of readBoundedChunks([{ chunk_index: 1, size_bytes: cap * 4 }], 0, 1,
    async (index, offset, length) => {
      calls.push([index, offset, length]);
      return Buffer.alloc(length);
    }, () => false)) assert.equal(data.length, 2);
  assert.deepEqual(calls, [[1, 0, 2]]);
});

test("ranges crossing chunk boundaries preserve bytes and offsets", async () => {
  const parts = [Buffer.from("abcde"), Buffer.from("fghijkl")];
  const out: Buffer[] = [];
  for await (const data of readBoundedChunks(
    parts.map((p, i) => ({ chunk_index: i + 1, size_bytes: p.length })), 3, 8,
    async (index, offset, length) => Buffer.from(parts[index - 1].subarray(offset, offset + length)),
    () => false,
  )) out.push(data);
  assert.equal(Buffer.concat(out).toString(), "defghi");
});

test("truncated database slices fail explicitly, not as successful partial playback", async () => {
  await assert.rejects(async () => {
    for await (const _ of readBoundedChunks([{ chunk_index: 1, size_bytes: 10 }], 0, 9,
      async () => Buffer.alloc(3), () => false)) { /* consume */ }
  }, { code: "STORAGE_READ_ERROR" });
});

test("missing chunk sequence fails rather than shifting byte offsets", async () => {
  await assert.rejects(async () => {
    for await (const _ of readBoundedChunks([{ chunk_index: 2, size_bytes: 10 }], 0, 9,
      async () => Buffer.alloc(10), () => false)) { /* consume */ }
  }, { code: "STORAGE_READ_ERROR" });
});

test("disconnect during a pending read prevents subsequent reads and yields", async () => {
  let stopped = false;
  let queries = 0;
  const iterator = readBoundedChunks([{ chunk_index: 1, size_bytes: cap * 4 }], 0, cap * 4 - 1,
    async (_i, _o, n) => { queries++; stopped = true; return Buffer.alloc(n); }, () => stopped);
  assert.equal((await iterator.next()).done, true);
  assert.equal(queries, 1);
});

test("slow simultaneous readers stay bounded and rapid disconnects stop querying", async () => {
  let queries = 0;
  let peakArrayBuffers = 0;
  await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    let stopped = false;
    const body: Readable = Readable.from(readBoundedChunks(
      [{ chunk_index: 1, size_bytes: cap * 32 }], 0, cap * 32 - 1,
      async (_index, _offset, length) => {
        queries++;
        assert.ok(length <= cap);
        const data = Buffer.alloc(length, i);
        peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
        return data;
      }, () => stopped || body.destroyed,
    ), { objectMode: false });
    let reads = 0;
    for await (const _data of body) {
      await delay(2);
      if (++reads === 4 && i % 2 === 0) { stopped = true; break; }
    }
    assert.ok(body.destroyed);
  }));
  assert.ok(queries < 8 * 32, "disconnected readers must not fetch the full object");
  console.log(JSON.stringify({ queries, peakArrayBuffersMb: Math.round(peakArrayBuffers / 1048576) }));
});

test("memory admission returns retryable 503 and automatically resumes", async () => {
  assert.doesNotThrow(assertStorageReadAdmission);
  pauseStorageReadAdmission(40);
  assert.throws(assertStorageReadAdmission, { code: "STORAGE_MEMORY_PRESSURE", statusCode: 503 });
  await delay(60);
  assert.doesNotThrow(assertStorageReadAdmission);
});
