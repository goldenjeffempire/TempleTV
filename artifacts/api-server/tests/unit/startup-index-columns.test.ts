import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Guard the boot SQL itself: these stale definitions failed on every
// production startup even though the application schema was up to date.
const source = readFileSync(
  new URL("../../src/infrastructure/db.ts", import.meta.url),
  "utf8",
);

function indexSql(name: string): string {
  const match = source.match(new RegExp(`await run\\("${name}", \\x60([\\s\\S]*?)\\x60\\)`));
  assert.ok(match, `Missing boot index definition: ${name}`);
  return match[1];
}

test("notification dispatch index does not depend on a nonexistent topic column", () => {
  assert.match(indexSql("idx_scheduled_notifications_dispatch"), /scheduled_notifications \(scheduled_at(?: ASC)?\)/);
  assert.doesNotMatch(source, /ON scheduled_notifications \(topic\)/);
  assert.doesNotMatch(source, /await run\("idx_scheduled_notifications_topic_status"/);
});

test("multipart storage index uses the upload identifier, not the UI session identifier", () => {
  assert.match(indexSql("idx_storage_upload_parts_upload"), /storage_upload_parts \(upload_id, part_number\)/);
  assert.doesNotMatch(source, /ON storage_upload_parts \(session_id/);
});

test("completed upload lookup index uses the schema's completed video column", () => {
  const sql = indexSql("idx_upload_sessions_completed_video_id");
  assert.match(sql, /upload_sessions \(completed_video_id\)/);
  assert.match(sql, /WHERE completed_video_id IS NOT NULL/);
  assert.doesNotMatch(source, /ON upload_sessions \(video_id\)/);
});
