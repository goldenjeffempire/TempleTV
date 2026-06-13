import { z } from "zod";
export declare const NotificationSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    type: z.ZodString;
    videoId: z.ZodNullable<z.ZodString>;
    sentAt: z.ZodString;
    createdAt: z.ZodString;
    scheduledAt: z.ZodString;
    sentCount: z.ZodNumber;
    status: z.ZodString;
    attempts: z.ZodNumber;
    errorMessage: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: string;
    status: string;
    body: string;
    title: string;
    id: string;
    createdAt: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
    attempts: number;
    scheduledAt: string;
    errorMessage: string | null;
}, {
    type: string;
    status: string;
    body: string;
    title: string;
    id: string;
    createdAt: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
    attempts: number;
    scheduledAt: string;
    errorMessage: string | null;
}>;
export declare const ListNotificationsQuerySchema: z.ZodObject<{
    limit: z.ZodEffects<z.ZodCatch<z.ZodDefault<z.ZodNumber>>, number, unknown>;
    offset: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
}, {
    limit?: unknown;
    offset?: number | undefined;
}>;
export declare const ListNotificationsResponseSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        body: z.ZodString;
        type: z.ZodString;
        videoId: z.ZodNullable<z.ZodString>;
        sentAt: z.ZodString;
        createdAt: z.ZodString;
        scheduledAt: z.ZodString;
        sentCount: z.ZodNumber;
        status: z.ZodString;
        attempts: z.ZodNumber;
        errorMessage: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        status: string;
        body: string;
        title: string;
        id: string;
        createdAt: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
        attempts: number;
        scheduledAt: string;
        errorMessage: string | null;
    }, {
        type: string;
        status: string;
        body: string;
        title: string;
        id: string;
        createdAt: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
        attempts: number;
        scheduledAt: string;
        errorMessage: string | null;
    }>, "many">;
    total: z.ZodNumber;
    limit: z.ZodNumber;
    offset: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    items: {
        type: string;
        status: string;
        body: string;
        title: string;
        id: string;
        createdAt: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
        attempts: number;
        scheduledAt: string;
        errorMessage: string | null;
    }[];
    total: number;
}, {
    limit: number;
    offset: number;
    items: {
        type: string;
        status: string;
        body: string;
        title: string;
        id: string;
        createdAt: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
        attempts: number;
        scheduledAt: string;
        errorMessage: string | null;
    }[];
    total: number;
}>;
export declare const SendPushBodySchema: z.ZodObject<{
    title: z.ZodString;
    body: z.ZodString;
    type: z.ZodDefault<z.ZodEnum<["live", "new_video", "announcement", "test", "app_update"]>>;
    videoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    idempotencyKey: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "test" | "live" | "new_video" | "announcement" | "app_update";
    body: string;
    title: string;
    videoId?: string | null | undefined;
    idempotencyKey?: string | undefined;
}, {
    body: string;
    title: string;
    type?: "test" | "live" | "new_video" | "announcement" | "app_update" | undefined;
    videoId?: string | null | undefined;
    idempotencyKey?: string | undefined;
}>;
export declare const SendPushResponseSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    type: z.ZodString;
    videoId: z.ZodNullable<z.ZodString>;
    sentAt: z.ZodString;
    createdAt: z.ZodString;
    scheduledAt: z.ZodString;
    sentCount: z.ZodNumber;
    status: z.ZodString;
    attempts: z.ZodNumber;
    errorMessage: z.ZodNullable<z.ZodString>;
} & {
    recipients: z.ZodNumber;
    delivered: z.ZodNumber;
    deduplicated: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    type: string;
    status: string;
    body: string;
    title: string;
    id: string;
    createdAt: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
    attempts: number;
    scheduledAt: string;
    errorMessage: string | null;
    recipients: number;
    delivered: number;
    deduplicated: boolean;
}, {
    type: string;
    status: string;
    body: string;
    title: string;
    id: string;
    createdAt: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
    attempts: number;
    scheduledAt: string;
    errorMessage: string | null;
    recipients: number;
    delivered: number;
    deduplicated: boolean;
}>;
