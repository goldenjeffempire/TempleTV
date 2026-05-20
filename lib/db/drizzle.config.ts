import { defineConfig } from "drizzle-kit";
import path from "path";

// Prefer Replit's built-in PG credentials over a stale DATABASE_URL secret.
if (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE) {
  const { PGHOST, PGPORT = "5432", PGUSER, PGPASSWORD = "", PGDATABASE } = process.env;
  process.env.DATABASE_URL = `postgresql://${PGUSER}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.join(__dirname, "./migrations"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
