import type { z } from "zod";
import type { ListNotificationsQuerySchema, SendPushBodySchema } from "./notifications.schemas.js";
export declare const notificationsService: {
    listHistory(query: z.infer<typeof ListNotificationsQuerySchema>): Promise<{
        items: {
            id: string;
            title: string;
            body: string;
            type: string;
            videoId: string | null;
            sentAt: string;
            sentCount: number;
        }[];
        total: number;
        limit: number;
        offset: number;
    }>;
    sendPush(body: z.infer<typeof SendPushBodySchema>): Promise<{
        recipients: number;
        delivered: number;
        id: string;
        title: string;
        body: string;
        type: string;
        videoId: string | null;
        sentAt: string;
        sentCount: number;
    }>;
};
