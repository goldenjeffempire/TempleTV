/**
 * Bounded body readers for outbound `fetch()` calls.
 *
 * Why this exists (production OOM, RSS hits 2 GiB every ~5 min):
 *   The YouTube live-page and watch-page scrapers in `routes/youtube.ts`
 *   and `lib/youtubeUrl.ts` use `await response.text()` on pages that are
 *   500 KB-1 MB of inlined JSON. The `pollLiveStatus()` ticker runs every
 *   15 s during burst windows, then every 60 s steady-state — the catalogue
 *   sync also fans out 30+ such fetches in parallel during the warm-up
 *   that immediately precedes the OOM in the production logs.
 *
 *   Two compounding leaks:
 *
 *   (1) Unbounded body size. A single rogue YouTube response (or a slow
 *       throttled connection that dribbles out a hung 5 MB shell) ties up
 *       multiple MB of `arrayBuffers` at once. With concurrent fetches in
 *       the catalogue sync, that's tens of MB transient and pieces stick
 *       around long enough to age into old-gen GC.
 *
 *   (2) V8 substring-sharing on retained regex matches. `String.match()`
 *       returns a SlicedString that references the ORIGINAL backing buffer.
 *       When `lastSnapshot` (a module-level variable in `routes/youtube.ts`)
 *       retains `videoId` / `title` extracted from a 1 MB HTML page, V8 keeps
 *       the entire 1 MB string alive even though only ~50 chars are reachable.
 *       Repeat every 60 s and `arrayBuffers` ratchets up monotonically until
 *       the cgroup OOM-killer fires.
 *
 * Both helpers below are surgically scoped — they don't change request
 * semantics, only memory footprint:
 *
 *   • `boundedText(response, maxBytes)` reads the body via ReadableStream
 *     reader, stops at `maxBytes`, calls `reader.cancel()` to free the
 *     upstream socket, and decodes through Buffer (which always produces a
 *     fresh SeqString, never a SlicedString). 256 KiB is the documented
 *     default — every regex marker the YouTube scrapers care about
 *     (`isLiveNow`, `videoId`, `hlsManifestUrl`, `title`, `concurrentViewers`)
 *     lives in the inlined `ytInitialPlayerResponse` JSON in the first
 *     ~150 KiB of every YouTube page. We've never observed a true marker
 *     beyond that offset.
 *
 *   • `freshString(s)` materializes a fresh SeqString from any string,
 *     defeating V8 substring-sharing on the result of `match[1]`. Use
 *     before storing a regex extraction into a long-lived variable.
 */

const DEFAULT_MAX_BYTES = 256 * 1024;

export async function boundedText(
  response: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body available (e.g. cached response). Fall back to
    // .text() but cap the result via slice-to-buffer to enforce the bound.
    const text = await response.text();
    if (text.length <= maxBytes) return freshString(text);
    return Buffer.from(text.slice(0, maxBytes), "utf8").toString("utf8");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - total;
      if (remaining <= 0) {
        // Body has already filled the cap — cancel to release the upstream
        // socket back to the keep-alive pool ASAP.
        try {
          await reader.cancel();
        } catch {}
        break;
      }

      if (value.byteLength > remaining) {
        chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
        total = maxBytes;
        try {
          await reader.cancel();
        } catch {}
        break;
      }

      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
  } catch {
    try {
      await reader.cancel();
    } catch {}
  }

  // Buffer.concat → toString("utf8") always produces a SeqString backed by
  // its own contiguous bytes. No SlicedString chain, no shared backing.
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Materialize a fresh, independently-backed string. Use immediately before
 * stashing a `match[1]` result into any long-lived structure (module-level
 * vars, caches, etc.) so the original (often megabyte-scale) backing buffer
 * can be GC'd as soon as the local scope ends.
 *
 * Implementation note: round-tripping through `Buffer` is the only
 * guaranteed-portable way to defeat V8 substring sharing across Node
 * versions. `String(s)`, `''+s`, `s.slice(0)` all may be optimized into
 * no-ops. `JSON.stringify` allocates but adds quote-escaping overhead.
 */
export function freshString(s: string | null | undefined): string {
  if (!s) return "";
  return Buffer.from(s, "utf8").toString("utf8");
}
