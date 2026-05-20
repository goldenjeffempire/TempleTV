import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { NotFoundError } from "../../shared/errors.js";
import type {
  CreateScheduleBodySchema,
  UpdateScheduleBodySchema,
} from "./schedule.schemas.js";

const sched = schema.scheduleTable;

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
  };
}

export const scheduleService = {
  async list() {
    const rows = await db
      .select()
      .from(sched)
      .orderBy(asc(sched.dayOfWeek), asc(sched.startTime));
    return { items: rows.map(toDto), total: rows.length };
  },

  async create(body: z.infer<typeof CreateScheduleBodySchema>) {
    const id = nanoid();
    const [row] = await db
      .insert(sched)
      .values({
        id,
        title: body.title,
        dayOfWeek: body.dayOfWeek,
        startTime: body.startTime,
        endTime: body.endTime ?? null,
        contentType: body.contentType,
        contentId: body.contentId ?? null,
        isRecurring: body.isRecurring,
        isActive: body.isActive,
      })
      .returning();
    return toDto(row!);
  },

  async update(id: string, body: z.infer<typeof UpdateScheduleBodySchema>) {
    const patch: Partial<typeof sched.$inferInsert> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.dayOfWeek !== undefined) patch.dayOfWeek = body.dayOfWeek;
    if (body.startTime !== undefined) patch.startTime = body.startTime;
    if (body.endTime !== undefined) patch.endTime = body.endTime;
    if (body.contentType !== undefined) patch.contentType = body.contentType;
    if (body.contentId !== undefined) patch.contentId = body.contentId;
    if (body.isRecurring !== undefined) patch.isRecurring = body.isRecurring;
    if (body.isActive !== undefined) patch.isActive = body.isActive;

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
};
