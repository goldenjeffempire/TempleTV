import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

const { Pool } = pg;

/**
 * Single shared pg pool. Pool sizing tuned for a 2 GiB container
 * with ~50 concurrent in-flight requests (each request usually
 * holds 0–1 connections); raise `max` if you scale the dyno up.
 */
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "temple-tv-api",
});

pool.on("error", (err) => {
  logger.error({ err }, "pg pool error");
});

export const db = drizzle(pool, { schema });
export { schema };
export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
