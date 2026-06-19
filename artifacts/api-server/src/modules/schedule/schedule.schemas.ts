import { z } from "zod";

export const ScheduleEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  contentType: z.string(),
  contentId: z.string().nullable(),
  isRecurring: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  scheduledDate: z.string().nullable(),
  priorityOverride: z.boolean(),
});

export const ListScheduleResponseSchema = z.object({
  items: z.array(ScheduleEntrySchema),
  total: z.number().int().nonnegative(),
});

export const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CreateScheduleBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    startTime: z.string().regex(TIME_RE, "must be HH:MM or HH:MM:SS"),
    endTime: z.string().regex(TIME_RE).nullable().optional(),
    contentType: z.enum(["live", "video", "playlist", "external"]),
    contentId: z.string().nullable().optional(),
    isRecurring: z.boolean().default(true),
    isActive: z.boolean().default(true),
    scheduledDate: z.string().regex(DATE_RE, "must be YYYY-MM-DD").nullable().optional(),
    priorityOverride: z.boolean().default(false),
  })
  .refine(
    (d) => {
      // One-time events need scheduledDate; recurring events need dayOfWeek.
      if (d.scheduledDate) return true; // one-time, dayOfWeek auto-derived
      return d.dayOfWeek !== undefined && d.dayOfWeek !== null;
    },
    { message: "Either dayOfWeek (recurring) or scheduledDate (one-time) is required" },
  );

export const UpdateScheduleBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  startTime: z.string().regex(TIME_RE).optional(),
  endTime: z.string().regex(TIME_RE).nullable().optional(),
  contentType: z.enum(["live", "video", "playlist", "external"]).optional(),
  contentId: z.string().nullable().optional(),
  isRecurring: z.boolean().optional(),
  isActive: z.boolean().optional(),
  scheduledDate: z.string().regex(DATE_RE).nullable().optional(),
  priorityOverride: z.boolean().optional(),
});
