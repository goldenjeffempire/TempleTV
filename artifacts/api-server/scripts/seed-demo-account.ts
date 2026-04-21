/**
 * Seeds (or refreshes) a demo account used by App Store / Play Store reviewers
 * to log in and exercise authenticated flows during review.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/seed-demo-account.ts
 *
 * Env vars (all optional; sensible defaults for review):
 *   DEMO_EMAIL    — defaults to "reviewer@templetv.org.ng"
 *   DEMO_PASSWORD — defaults to "TempleTV-Review-2026!"
 *   DEMO_NAME     — defaults to "App Store Reviewer"
 *
 * The script is idempotent: if the user already exists, the password and
 * display name are reset so the credentials in the App Store Connect /
 * Play Console review notes always work.
 */

import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, usersTable } from "@workspace/db";

async function main() {
  const email = (process.env.DEMO_EMAIL ?? "reviewer@templetv.org.ng").toLowerCase();
  const password = process.env.DEMO_PASSWORD ?? "TempleTV-Review-2026!";
  const displayName = process.env.DEMO_NAME ?? "App Store Reviewer";

  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(usersTable)
      .set({
        passwordHash,
        displayName,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.email, email));
    console.log(`[seed-demo-account] Refreshed existing demo account: ${email}`);
  } else {
    await db.insert(usersTable).values({
      id: randomUUID(),
      email,
      passwordHash,
      displayName,
      emailVerified: true,
    });
    console.log(`[seed-demo-account] Created demo account: ${email}`);
  }

  console.log("");
  console.log("=== Reviewer credentials (paste into App Store Connect / Play Console) ===");
  console.log(`Email:    ${email}`);
  console.log(`Password: ${password}`);
  console.log("==========================================================================");
}

main()
  .then(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed-demo-account] Failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
