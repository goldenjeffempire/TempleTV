/** Bound transferred BYTEA values, not merely the number of database rows. */
export const STORAGE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

export type StoredChunk = {
  chunk_index: number;
  size_bytes: number;
};

export async function* readBoundedChunks(
  chunks: StoredChunk[],
  start: number,
  end: number,
  fetchSlice: (index: number, offset: number, length: number) => Promise<Buffer>,
  shouldStop: () => boolean,
): AsyncGenerator<Buffer> {
  let cursor = 0;
  for (const [position, chunk] of chunks.entries()) {
    if (chunk.chunk_index !== position + 1) {
      throw Object.assign(new Error("Stored chunk sequence is incomplete"), { code: "STORAGE_READ_ERROR" });
    }
    if (!Number.isSafeInteger(chunk.size_bytes) || chunk.size_bytes <= 0) {
      throw Object.assign(new Error("Invalid stored chunk size"), { code: "STORAGE_READ_ERROR" });
    }
    const chunkStart = cursor;
    cursor += chunk.size_bytes;
    if (cursor <= start) continue;
    if (chunkStart > end) break;
    let offset = Math.max(0, start - chunkStart);
    const limit = Math.min(chunk.size_bytes, end - chunkStart + 1);
    while (offset < limit) {
      if (shouldStop()) return;
      const length = Math.min(STORAGE_READ_CHUNK_BYTES, limit - offset);
      const data = await fetchSlice(chunk.chunk_index, offset, length);
      if (shouldStop()) return;
      if (data.length !== length) {
        throw Object.assign(new Error("Stored chunk missing or truncated"), { code: "STORAGE_READ_ERROR" });
      }
      yield data;
      offset += data.length;
    }
  }
}
