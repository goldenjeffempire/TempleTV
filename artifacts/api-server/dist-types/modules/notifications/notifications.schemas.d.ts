import { z } from "zod";
export declare const NotificationSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    type: z.ZodString;
    videoId: z.ZodNullable<z.ZodString>;
    sentAt: z.ZodString;
    sentCount: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: string;
    body: string;
    title: string;
    id: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
}, {
    type: string;
    body: string;
    title: string;
    id: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
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
        sentCount: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        type: string;
        body: string;
        title: string;
        id: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
    }, {
        type: string;
        body: string;
        title: string;
        id: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
    }>, "many">;
    total: z.ZodNumber;
    limit: z.ZodNumber;
    offset: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    items: {
        type: string;
        body: string;
        title: string;
        id: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
    }[];
    total: number;
}, {
    limit: number;
    offset: number;
    items: {
        type: string;
        body: string;
        title: string;
        id: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
    }[];
    total: number;
}>;
export declare const SendPushBodySchema: z.ZodObject<{
    title: z.ZodString;
    body: z.ZodString;
    type: z.ZodDefault<z.ZodEnum<["live", "new_video", "announcement", "test"]>>;
    videoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    type: "test" | "live" | "new_video" | "announcement";
    body: string;
    title: string;
    videoId?: string | null | undefined;
}, {
    body: string;
    title: string;
    type?: "test" | "live" | "new_video" | "announcement" | undefined;
    videoId?: string | null | undefined;
}>;
export declare const SendPushResponseSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    type: z.ZodString;
    videoId: z.ZodNullable<z.ZodString>;
    sentAt: z.ZodString;
    sentCount: z.ZodNumber;
} & {
    recipients: z.ZodNumber;
    delivered: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: string;
    body: string;
    title: string;
    id: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
    recipients: number;
    delivered: number;
}, {
    type: string;
    body: string;
    title: string;
    id: string;
    videoId: string | null;
    sentAt: string;
    sentCount: number;
    recipients: number;
    delivered: number;
}>;
