import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const appVersionsTable = pgTable("app_versions", {
  id:                    text("id").primaryKey(),
  platform:              text("platform", { enum: ["ios", "android", "all"] }).notNull().default("all"),
  versionString:         text("version_string").notNull(),
  versionCode:           integer("version_code").notNull().default(0),
  channel:               text("channel", { enum: ["production", "staging", "preview"] }).notNull().default("production"),
  isMandatory:           boolean("is_mandatory").notNull().default(false),
  minRequiredVersion:    text("min_required_version"),
  releaseNotes:          text("release_notes"),
  storeUrlAndroid:       text("store_url_android"),
  storeUrlIos:           text("store_url_ios"),
  pushNotificationSent:  boolean("push_notification_sent").notNull().default(false),
  isActive:              boolean("is_active").notNull().default(true),
  createdAt:             timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:             timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
