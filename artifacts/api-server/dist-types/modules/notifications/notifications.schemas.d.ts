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
    id: string;
    title: string;
    videoId: string | null;
    errorMessage: string | null;
    attempts: number;
    createdAt: string;
    body: string;
    sentAt: string;
    sentCount: number;
    scheduledAt: string;
}, {
    type: string;
    status: string;
    id: string;
    title: string;
    videoId: string | null;
    errorMessage: string | null;
    attempts: number;
    createdAt: string;
    body: string;
    sentAt: string;
    sentCount: number;
    scheduledAt: string;
}>;
export declare const ListNotificationsQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
}, {
    limit?: number | undefined;
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
        id: string;
        title: string;
        videoId: string | null;
        errorMessage: string | null;
        attempts: number;
        createdAt: string;
        body: string;
        sentAt: string;
        sentCount: number;
        scheduledAt: string;
    }, {
        type: string;
        status: string;
        id: string;
        title: string;
        videoId: string | null;
        errorMessage: string | null;
        attempts: number;
        createdAt: string;
        body: string;
        sentAt: string;
        sentCount: number;
        scheduledAt: string;
    }>, "many">;
    total: z.ZodNumber;
    limit: z.ZodNumber;
    offset: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    items: {
        type: string;
        status: string;
        id: string;
        title: string;
        videoId: string | null;
        errorMessage: string | null;
        attempts: number;
        createdAt: string;
        body: string;
        sentAt: string;
        sentCount: number;
        scheduledAt: string;
    }[];
    total: number;
    limit: number;
    offset: number;
}, {
    items: {
        type: string;
        status: string;
        id: string;
        title: string;
        videoId: string | null;
        errorMessage: string | null;
        attempts: number;
        createdAt: string;
        body: string;
        sentAt: string;
        sentCount: number;
        scheduledAt: string;
    }[];
    total: number;
    limit: number;
    offset: number;
}>;
export declare const SendPushBodySchema: z.ZodObject<{
    title: z.ZodString;
    body: z.ZodString;
    type: z.ZodDefault<z.ZodEnum<["live", "new_video", "announcement", "test", "app_update"]>>;
    videoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    idempotencyKey: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "test" | "live" | "new_video" | "announcement" | "app_update";
    title: string;
    body: string;
    videoId?: string | null | undefined;
    idempotencyKey?: string | undefined;
}, {
    title: string;
    body: string;
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
    id: string;
    title: string;
    videoId: string | null;
    errorMessage: string | null;
    attempts: number;
    createdAt: string;
    body: string;
    sentAt: string;
    sentCount: number;
    scheduledAt: string;
    delivered: number;
    recipients: number;
    deduplicated: boolean;
}, {
    type: string;
    status: string;
    id: string;
    title: string;
    videoId: string | null;
    errorMessage: string | null;
    attempts: number;
    createdAt: string;
    body: string;
    sentAt: string;
    sentCount: number;
    scheduledAt: string;
    delivered: number;
    recipients: number;
    deduplicated: boolean;
}>;
