import { z } from "zod";

export const ScheduleEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string(),
  endTime: z.string().nullable(),
  contentType: z.string(),
  contentId: z.string().nullable(),
  isRecurring: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
});

export const ListScheduleResponseSchema = z.object({
  items: z.array(ScheduleEntrySchema),
  total: z.number().int().nonnegative(),
});

export const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

export const CreateScheduleBodySchema = z.object({
  title: z.string().min(1).max(200),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_RE, "must be HH:MM or HH:MM:SS"),
  endTime: z.string().regex(TIME_RE).nullable().optional(),
  contentType: z.enum(["live", "video", "playlist", "external"]),
  contentId: z.string().nullable().optional(),
  isRecurring: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

export const UpdateScheduleBodySchema = CreateScheduleBodySchema.partial();
