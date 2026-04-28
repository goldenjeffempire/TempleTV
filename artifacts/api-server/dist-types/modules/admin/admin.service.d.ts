import type { z } from "zod";
import type { ListUsersQuerySchema, UpdateUserRoleBodySchema } from "./admin.schemas.js";
export declare const adminService: {
    listUsers(query: z.infer<typeof ListUsersQuerySchema>): Promise<{
        items: {
            id: string;
            email: string;
            displayName: string;
            avatarUrl: string | null;
            role: string;
            emailVerified: boolean;
            createdAt: string;
            updatedAt: string;
        }[];
        total: number;
        limit: number;
        offset: number;
    }>;
    updateUserRole(id: string, body: z.infer<typeof UpdateUserRoleBodySchema>): Promise<{
        id: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
        role: string;
        emailVerified: boolean;
        createdAt: string;
        updatedAt: string;
    }>;
    getStats(): Promise<{
        videos: {
            total: number;
            featured: number;
            bySource: Record<string, number>;
        };
        users: {
            total: number;
            byRole: Record<string, number>;
        };
        playlists: {
            total: number;
        };
        schedule: {
            total: number;
            active: number;
        };
        notifications: {
            sentLast24h: number;
            sentTotal: number;
        };
        broadcast: {
            queueDepth: number;
            activeQueueDepth: number;
        };
        generatedAt: string;
    }>;
    getAnalytics(): Promise<{
        topVideos: {
            id: string;
            title: string;
            viewCount: number;
            thumbnailUrl: string;
        }[];
        totalViews: number;
        generatedAt: string;
    }>;
};
