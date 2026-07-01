import { asc, eq, gte, isNotNull, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { NotFoundError } from "../../shared/errors.js";
import type {
  CreateScheduleBodySchema,
  UpdateScheduleBodySchema,
} from "./schedule.schemas.js";

const sched = schema.scheduleTable;

/**
 * Derive the weekday (0 = Sunday … 6 = Saturday) from an ISO date string
 * "YYYY-MM-DD", parsed as a **local** date to avoid UTC-shift issues.
 *
 * Throws if the result is not a valid integer weekday — this catches future
 * refactors that might accidentally pass a time value or a non-date string,
 * which historically caused `day_of_week = 313` queries (313 = 5*60+13,
 * the number of minutes since midnight at 05:13).
 */
function dayOfWeekFromDate(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const result = new Date(y!, m! - 1, d!).getDay();
  if (!Number.isInteger(result) || result < 0 || result > 6) {
    throw new Error(
      `dayOfWeekFromDate: computed invalid weekday ${result} from date "${dateStr}". ` +
        "Expected 0 (Sunday) through 6 (Saturday).",
    );
  }
  return result;
}

/**
 * Validate that a dayOfWeek value is a valid JS weekday integer (0–6).
 * Throws for any value outside this range, including the nowMinutes()-derived
 * values like 313 that caused the historical bug.
 */
function assertValidDayOfWeek(value: number | null | undefined, context: string): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw new Error(
      `${context}: invalid day_of_week ${value} (must be 0–6). ` +
        "Check whether a minute-of-day value (e.g. nowMinutes()) was accidentally used here.",
    );
  }
}

function toDto(row: typeof sched.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    contentType: row.contentType,
    contentId: row.contentId,
    isRecurring: row.isRecurring,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    scheduledDate: row.scheduledDate,
    priorityOverride: row.priorityOverride,
  };
}

export const scheduleService = {
  /**
   * Lists all schedule entries.
   *
   * Recurring entries are sorted by dayOfWeek then startTime.
   * One-time (dated) entries are appended at the end, sorted by scheduledDate
   * then startTime.
   */
  async list() {
    const rows = await db
      .select()
      .from(sched)
      .orderBy(asc(sched.dayOfWeek), asc(sched.startTime));
    return { items: rows.map(toDto), total: rows.length };
  },

  /**
   * Returns upcoming one-time events (scheduledDate >= today) sorted by date
   * then startTime. Used by the admin "Upcoming Events" panel.
   */
  async listUpcoming() {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const rows = await db
      .select()
      .from(sched)
      .where(
        and(
          isNotNull(sched.scheduledDate),
          gte(sched.scheduledDate, todayStr),
          eq(sched.isActive, true),
        ),
      )
      .orderBy(asc(sched.scheduledDate), asc(sched.startTime));
    return { items: rows.map(toDto), total: rows.length };
  },

  async create(body: z.infer<typeof CreateScheduleBodySchema>) {
    const id = nanoid();

    // Derive dayOfWeek from scheduledDate for one-time entries so the column
    // always has a value (useful for informational display even though the
    // bridge matches on scheduledDate for one-time events).
    let dayOfWeek = body.dayOfWeek ?? null;
    if (body.scheduledDate && dayOfWeek === null) {
      dayOfWeek = dayOfWeekFromDate(body.scheduledDate);
    }

    // Belt-and-suspenders: Zod has already validated 0–6 for body.dayOfWeek,
    // but guard the final value again (including the derived one) to catch
    // any future refactor that re-introduces the nowMinutes() confusion.
    assertValidDayOfWeek(dayOfWeek, "scheduleService.create");

    const [row] = await db
      .insert(sched)
      .values({
        id,
        title: body.title,
        dayOfWeek,
        startTime: body.startTime,
        endTime: body.endTime ?? null,
        contentType: body.contentType,
        contentId: body.contentId ?? null,
        isRecurring: body.scheduledDate ? false : (body.isRecurring ?? true),
        isActive: body.isActive ?? true,
        scheduledDate: body.scheduledDate ?? null,
        priorityOverride: body.priorityOverride ?? false,
      })
      .returning();
    return toDto(row!);
  },

  async update(id: string, body: z.infer<typeof UpdateScheduleBodySchema>) {
    const patch: Partial<typeof sched.$inferInsert> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.startTime !== undefined) patch.startTime = body.startTime;
    if (body.endTime !== undefined) patch.endTime = body.endTime;
    if (body.contentType !== undefined) patch.contentType = body.contentType;
    if (body.contentId !== undefined) patch.contentId = body.contentId;
    if (body.isRecurring !== undefined) patch.isRecurring = body.isRecurring;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.priorityOverride !== undefined) patch.priorityOverride = body.priorityOverride;

    // Handle scheduledDate + dayOfWeek together
    if (body.scheduledDate !== undefined) {
      patch.scheduledDate = body.scheduledDate;
      if (body.scheduledDate) {
        patch.isRecurring = false;
        patch.dayOfWeek = body.dayOfWeek ?? dayOfWeekFromDate(body.scheduledDate);
      }
    }
    if (body.dayOfWeek !== undefined && body.scheduledDate === undefined) {
      patch.dayOfWeek = body.dayOfWeek;
    }

    // Belt-and-suspenders: validate the final dayOfWeek that will be written
    // to the DB, regardless of source (Zod body, derived from date, or passthrough).
    assertValidDayOfWeek(patch.dayOfWeek, "scheduleService.update");

    if (Object.keys(patch).length === 0) {
      const [row] = await db.select().from(sched).where(eq(sched.id, id)).limit(1);
      if (!row) throw new NotFoundError("Schedule entry not found");
      return toDto(row);
    }

    const [row] = await db.update(sched).set(patch).where(eq(sched.id, id)).returning();
    if (!row) throw new NotFoundError("Schedule entry not found");
    return toDto(row);
  },

  async delete(id: string) {
    const deleted = await db.delete(sched).where(eq(sched.id, id)).returning();
    if (deleted.length === 0) throw new NotFoundError("Schedule entry not found");
    return { id, deleted: true };
  },

  /** Mark a one-time entry as inactive after it fires (prevents re-fire on server restart). */
  async deactivateOneTime(id: string) {
    await db.update(sched).set({ isActive: false }).where(eq(sched.id, id));
  },
};
