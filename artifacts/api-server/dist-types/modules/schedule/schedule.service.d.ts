import type { z } from "zod";
import type { CreateScheduleBodySchema, UpdateScheduleBodySchema } from "./schedule.schemas.js";
export declare const scheduleService: {
    list(): Promise<{
        items: {
            id: string;
            title: string;
            dayOfWeek: number;
            startTime: string;
            endTime: string | null;
            contentType: string;
            contentId: string | null;
            isRecurring: boolean;
            isActive: boolean;
            createdAt: string;
        }[];
        total: number;
    }>;
    create(body: z.infer<typeof CreateScheduleBodySchema>): Promise<{
        id: string;
        title: string;
        dayOfWeek: number;
        startTime: string;
        endTime: string | null;
        contentType: string;
        contentId: string | null;
        isRecurring: boolean;
        isActive: boolean;
        createdAt: string;
    }>;
    update(id: string, body: z.infer<typeof UpdateScheduleBodySchema>): Promise<{
        id: string;
        title: string;
        dayOfWeek: number;
        startTime: string;
        endTime: string | null;
        contentType: string;
        contentId: string | null;
        isRecurring: boolean;
        isActive: boolean;
        createdAt: string;
    }>;
    delete(id: string): Promise<{
        id: string;
        deleted: boolean;
    }>;
};
