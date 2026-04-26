/**
 * Backfill: rewrite legacy `/api/uploads/<uuid>.<ext>` URLs on the
 * `managed_videos` table to the canonical `/api/videos/:id/source` redirect
 * route, but only for rows that actually have an `objectPath` set (i.e. the
 * file is mirrored in S3 and the canonical 302-redirect will succeed).
 *
 * The canonical route lives at:
 *   GET  /api/videos/:id/source   (artifacts/api-server/src/routes/admin.ts)
 *
 * Why this matters
 * ────────────────
 * The legacy `/api/uploads/<file>` path streams bytes through the Node
 * process when no S3 mirror exists, and even when it does it goes through
 * the static-fallback handler. The canonical `/api/videos/:id/source` route
 * issues a clean, CDN-cacheable 302 redirect straight to a presigned S3
 * URL, which is materially faster (lower TTFF, no Node bandwidth, edge
 * cacheable). Rows minted by the upload flow already use the canonical
 * URL — this script only touches the older rows that pre-date that change.
 *
 * Behaviour
 * ─────────
 *   - Idempotent: rewritten rows no longer match the LIKE filter, so
 *     re-runs find nothing and exit 0.
 *   - Safe: only touches rows where `object_path` is set. If S3 doesn't
 *     have the file, the row is left alone so the legacy fallback can
 *     still serve it.
 *   - Origin-preserving: if the existing URL is absolute
 *     (`https://host/api/uploads/x.mp4`) we keep the same origin
 *     (`https://host/api/videos/<id>/source`); if it's relative
 *     (`/api/uploads/x.mp4`) the rewrite stays relative.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-legacy-video-urls
 */

import { and, eq, isNotNull, like } from "drizzle-orm";
import { db, pool, videosTable } from "@workspace/db";

const LEGACY_PATH = "/api/uploads/";

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: videosTable.id,
      localVideoUrl: videosTable.localVideoUrl,
      objectPath: videosTable.objectPath,
    })
    .from(videosTable)
    .where(
      and(
        isNotNull(videosTable.localVideoUrl),
        isNotNull(videosTable.objectPath),
        like(videosTable.localVideoUrl, `%${LEGACY_PATH}%`),
      ),
    );

  console.log(
    `[backfill-legacy-video-urls] ${rows.length} candidate row(s) to rewrite.`,
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const current = row.localVideoUrl;
    if (!current) {
      skipped++;
      continue;
    }

    const idx = current.indexOf(LEGACY_PATH);
    if (idx < 0) {
      skipped++;
      continue;
    }

    const origin = current.slice(0, idx);
    const next = `${origin}/api/videos/${row.id}/source`;

    if (next === current) {
      skipped++;
      continue;
    }

    try {
      await db
        .update(videosTable)
        .set({ localVideoUrl: next })
        .where(eq(videosTable.id, row.id));
      updated++;
      console.log(`  ✓ ${row.id}: ${current} → ${next}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${row.id}:`, err);
    }
  }

  console.log(
    `[backfill-legacy-video-urls] done — updated=${updated} skipped=${skipped} failed=${failed}`,
  );

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill-legacy-video-urls] fatal:", err);
  process.exit(1);
});
