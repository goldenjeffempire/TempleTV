import { z } from "zod";
export declare const ScheduleEntrySchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    dayOfWeek: z.ZodNumber;
    startTime: z.ZodString;
    endTime: z.ZodNullable<z.ZodString>;
    contentType: z.ZodString;
    contentId: z.ZodNullable<z.ZodString>;
    isRecurring: z.ZodBoolean;
    isActive: z.ZodBoolean;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    title: string;
    contentType: string;
    isActive: boolean;
    createdAt: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string | null;
    contentId: string | null;
    isRecurring: boolean;
}, {
    id: string;
    title: string;
    contentType: string;
    isActive: boolean;
    createdAt: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string | null;
    contentId: string | null;
    isRecurring: boolean;
}>;
export declare const ListScheduleResponseSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        dayOfWeek: z.ZodNumber;
        startTime: z.ZodString;
        endTime: z.ZodNullable<z.ZodString>;
        contentType: z.ZodString;
        contentId: z.ZodNullable<z.ZodString>;
        isRecurring: z.ZodBoolean;
        isActive: z.ZodBoolean;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        contentType: string;
        isActive: boolean;
        createdAt: string;
        dayOfWeek: number;
        startTime: string;
        endTime: string | null;
        contentId: string | null;
        isRecurring: boolean;
    }, {
        id: string;
        title: string;
        contentType: string;
        isActive: boolean;
        createdAt: string;
        dayOfWeek: number;
        startTime: string;
        endTime: string | null;
        contentId: string | null;
        isRecurring: boolean;
    }>, "many">;
    total: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    total: number;
    items: {
        id: string;
        title: string;
        contentType: string;
        isActive: boolean;
        createdAt: string;
        dayOfWeek: number;
        startTime: string;
        endTime: string | null;
        contentId: string | null;
        isRecurring: boolean;
    }[];
}, {
    total: number;
    items: {
        id: string;
        title: string;
        contentType: string;
        isActive: boolean;
        createdAt: string;
        dayOfWeek: number;
        startTime: string;
        endTime: string | null;
        contentId: string | null;
        isRecurring: boolean;
    }[];
}>;
export declare const TIME_RE: RegExp;
export declare const CreateScheduleBodySchema: z.ZodObject<{
    title: z.ZodString;
    dayOfWeek: z.ZodNumber;
    startTime: z.ZodString;
    endTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    contentType: z.ZodEnum<["live", "video", "playlist", "external"]>;
    contentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isRecurring: z.ZodDefault<z.ZodBoolean>;
    isActive: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    title: string;
    contentType: "live" | "video" | "external" | "playlist";
    isActive: boolean;
    dayOfWeek: number;
    startTime: string;
    isRecurring: boolean;
    endTime?: string | null | undefined;
    contentId?: string | null | undefined;
}, {
    title: string;
    contentType: "live" | "video" | "external" | "playlist";
    dayOfWeek: number;
    startTime: string;
    isActive?: boolean | undefined;
    endTime?: string | null | undefined;
    contentId?: string | null | undefined;
    isRecurring?: boolean | undefined;
}>;
export declare const UpdateScheduleBodySchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    dayOfWeek: z.ZodOptional<z.ZodNumber>;
    startTime: z.ZodOptional<z.ZodString>;
    endTime: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    contentType: z.ZodOptional<z.ZodEnum<["live", "video", "playlist", "external"]>>;
    contentId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    isRecurring: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    isActive: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    title?: string | undefined;
    contentType?: "live" | "video" | "external" | "playlist" | undefined;
    isActive?: boolean | undefined;
    dayOfWeek?: number | undefined;
    startTime?: string | undefined;
    endTime?: string | null | undefined;
    contentId?: string | null | undefined;
    isRecurring?: boolean | undefined;
}, {
    title?: string | undefined;
    contentType?: "live" | "video" | "external" | "playlist" | undefined;
    isActive?: boolean | undefined;
    dayOfWeek?: number | undefined;
    startTime?: string | undefined;
    endTime?: string | null | undefined;
    contentId?: string | null | undefined;
    isRecurring?: boolean | undefined;
}>;
