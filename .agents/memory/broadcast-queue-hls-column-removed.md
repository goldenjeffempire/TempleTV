---
name: broadcast_queue hlsMasterUrl column removed
description: hls_master_url no longer exists on the broadcast_queue table; why lingering references are latent runtime 500s, not just type drift.
---

# broadcast_queue `hls_master_url` was removed — but `videos`/`channel_queue` still have it

`hls_master_url` exists in `lib/db/src/schema/videos.ts` and `channel-queue.ts`, but was
**removed from `lib/db/src/schema/broadcast-queue.ts`** during the MP4-only cutover. It is
NOT a stale build artifact — the column is genuinely gone from that one table.

## The rule
After removing a column from a Drizzle table, grep EVERY `.insert(table).values({...})`,
`.onConflictDoUpdate({ set: {...} })`, and raw row reads for the removed field name.

**Why:** Drizzle's `.values()`/`.set()` iterate the *input object's* keys and look each up in
the table's column map. A key with no matching column dereferences `undefined.name` →
throws at runtime (`Cannot read properties of undefined (reading 'name')`). So an INSERT/UPDATE
that still passes the removed column is a **latent runtime 500**, not benign type drift —
esbuild strips the type error, so it only surfaces when that write path executes. On Temple TV
the `broadcast_queue` write path (`broadcast.service.addToQueue`, `prod-queue-sync` upsert) is
rarely hit because broadcast is YouTube-only, which is why it stayed latent.

**How to apply:** Reads of a removed column are merely always-`undefined`/empty (safe to delete
as dead fallbacks). Writes are the dangerous ones — remove the key entirely. For
`broadcast_queue`, HLS is now sourced authoritatively from `managed_videos` (`videoMeta.hlsMasterUrl`
in the admin-broadcast coalesced DTO); do not reintroduce a queue-row HLS field.
