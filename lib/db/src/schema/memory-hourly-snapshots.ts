import { pgTable, serial, real, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const memoryHourlySnapshotsTable = pgTable(
  "memory_hourly_snapshots",
  {
    id: serial("id").primaryKey(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
    rssMb: real("rss_mb").notNull(),
    heapUsedMb: real("heap_used_mb").notNull(),
    heapTotalMb: real("heap_total_mb").notNull(),
    externalMb: real("external_mb").notNull(),
    heapUsedGrowthMbPerMin: real("heap_used_growth_mb_per_min"),
    externalGrowthMbPerMin: real("external_growth_mb_per_min"),
    namedStores: jsonb("named_stores").$type<Array<{ name: string; size: number; peak: number }>>().notNull(),
  },
  (t) => [
    index("memory_hourly_snapshots_snapshot_at_idx").on(t.snapshotAt),
  ],
);

export type MemoryHourlySnapshotRow = typeof memoryHourlySnapshotsTable.$inferSelect;
