import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

/**
 * Emergency Alerts — full-screen broadcast interruptions pushed to all clients.
 *
 * When an alert is created and isActive = true, the SSE gateway pushes an
 * EMERGENCY_BROADCAST omega-signal to every connected client. TV clients
 * render a full-screen takeover; mobile clients render a prominent banner.
 *
 * Severity:
 *   info      — General announcement (blue). Clients may dismiss.
 *   warning   — Important notice (amber). Clients may dismiss after 10s.
 *   critical  — Urgent alert (red). Clients cannot dismiss (only admin can).
 *   emergency — Maximum priority (red flashing). Cannot be dismissed by client.
 */
export const emergencyAlertsTable = pgTable(
  "emergency_alerts",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull().default("all"),
    title: text("title").notNull(),
    message: text("message").notNull(),
    severity: text("severity", {
      enum: ["info", "warning", "critical", "emergency"],
    })
      .notNull()
      .default("info"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_emergency_alerts_active").on(t.isActive, t.createdAt),
    index("idx_emergency_alerts_channel").on(t.channelId, t.isActive),
  ],
);

export type EmergencyAlert = typeof emergencyAlertsTable.$inferSelect;
export type NewEmergencyAlert = typeof emergencyAlertsTable.$inferInsert;
