import { pgTable, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscriptionTiersTable = pgTable("subscription_tiers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  priceMonthlyCents: integer("price_monthly_cents").notNull().default(0),
  priceYearlyCents: integer("price_yearly_cents").notNull().default(0),
  features: text("features").notNull().default("[]"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSubscriptionsTable = pgTable("user_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tierId: text("tier_id").notNull(),
  status: text("status").notNull().default("active"),
  provider: text("provider").notNull().default("manual"),
  providerSubscriptionId: text("provider_subscription_id"),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull().defaultNow(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSubscriptionTierSchema = createInsertSchema(subscriptionTiersTable).omit({ createdAt: true, updatedAt: true });
export const insertUserSubscriptionSchema = createInsertSchema(userSubscriptionsTable).omit({ createdAt: true, updatedAt: true });

export type SubscriptionTier = typeof subscriptionTiersTable.$inferSelect;
export type UserSubscription = typeof userSubscriptionsTable.$inferSelect;
export type InsertSubscriptionTier = z.infer<typeof insertSubscriptionTierSchema>;
export type InsertUserSubscription = z.infer<typeof insertUserSubscriptionSchema>;
