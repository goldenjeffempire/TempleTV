import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

// Opt-in, development-only. Temporary tables are private to one transaction;
// no catalog media or persistent database rows are changed.
test("actual PostgreSQL storage reads: probes, seeks, concurrent readers, and relief", {
  skip: process.env.RUN_STORAGE_MEMORY_TESTS !== "1" || process.env.NODE_ENV !== "development",
}, async () => {
  const { db, pgPool } = await import("../../src/infrastructure/db.js");
  const { storage, getActiveStorageStreamCount } = await import("../../src/infrastructure/storage.js");
  const { pauseStorageReadAdmission } = await import("../../src/infrastructure/storage-read-admission.js");
  const size = 16 * 1024 * 1024;
  const execute = db.execute;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE TEMP TABLE storage_blob_chunks
        (blob_key text, chunk_index integer, data bytea, size_bytes integer) ON COMMIT DROP`));
      await tx.execute(sql.raw(`CREATE TEMP TABLE storage_blobs
        (key text, size_bytes integer, content_type text, chunked boolean, chunk_count integer) ON COMMIT DROP`));
      await tx.execute(sql`INSERT INTO storage_blob_chunks VALUES
        ('memory-test', 1, decode(repeat('ab', ${size}), 'hex'), ${size}),
        ('memory-test', 2, decode(repeat('cd', ${size}), 'hex'), ${size})`);
      await tx.execute(sql`INSERT INTO storage_blobs VALUES
        ('memory-test', ${size * 2}, 'video/mp4', true, 2)`);
      // Pin production storage SQL to this connection's isolated temp tables.
      const executeOnConnection = tx.execute.bind(tx);
      let pending: Promise<unknown> = Promise.resolve();
      db.execute = ((...args: Parameters<typeof tx.execute>) => {
        const result = pending.then(() => executeOnConnection(...args));
        pending = result.then(() => undefined, () => undefined);
        return result;
      }) as typeof db.execute;
      const s = storage();
      const probe = await s.getObjectRange("memory-test", 0, 1);
      assert.ok(probe);
      const probeParts: Buffer[] = [];
      for await (const data of probe.body) probeParts.push(data);
      assert.deepEqual(Buffer.concat(probeParts), Buffer.from([0xab, 0xab]));

      const seek = await s.getObjectRange("memory-test", size - 2, size + 1);
      assert.ok(seek);
      const seekParts: Buffer[] = [];
      for await (const data of seek.body) seekParts.push(data);
      assert.deepEqual(Buffer.concat(seekParts), Buffer.from([0xab, 0xab, 0xcd, 0xcd]));

      let bytes = 0;
      let maxResultBytes = 0;
      let peakRss = process.memoryUsage().rss;
      const baseline = getActiveStorageStreamCount();
      for (let round = 0; round < 3; round++) {
        await Promise.all(Array.from({ length: 8 }, async (_, index) => {
          const object = await s.getObject("memory-test");
          let received = 0;
          for await (const data of object.body) {
            assert.ok(data.length <= 4 * 1024 * 1024);
            maxResultBytes = Math.max(maxResultBytes, data.length);
            peakRss = Math.max(peakRss, process.memoryUsage().rss);
            bytes += data.length;
            received++;
            if (index % 2 === 0 && received === 1) break;
          }
        }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getActiveStorageStreamCount(), baseline);
      pauseStorageReadAdmission(30);
      await assert.rejects(s.getObject("memory-test"), { code: "STORAGE_MEMORY_PRESSURE", statusCode: 503 });
      await assert.rejects(s.getObjectRange("memory-test", 0, 1), { code: "STORAGE_MEMORY_PRESSURE", statusCode: 503 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const recovered = await s.getObjectRange("memory-test", 0, 1);
      assert.ok(recovered);
      for await (const data of recovered.body) assert.equal(data.length, 2);
      console.log(JSON.stringify({
        bytesTransferred: bytes, maxResultBytes,
        peakRssMb: Math.round(peakRss / 1048576),
        activeReadersAfter: getActiveStorageStreamCount(),
      }));
      assert.ok(peakRss < 460 * 1048576, "isolated storage test must stay below the production hard ceiling");
    });
  } finally {
    db.execute = execute;
    await pgPool.end();
  }
});
